#ifndef COMPONENTS_REMOTE_PAINT_CAPTURE_HOST_REGISTRY_H_
#define COMPONENTS_REMOTE_PAINT_CAPTURE_HOST_REGISTRY_H_

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <list>
#include <iterator>
#include <map>
#include <memory>
#include <mutex>
#include <utility>
#include <vector>

namespace remote_paint {

// One registry belongs to a renderer process. Admitted immutable encodings
// remain charged until their final returned alias is released, even after
// cache eviction or host destruction. Uncached encoding/IPC work is separate.
template <typename Value>
class CaptureHostRegistry {
 public:
  struct Token {
    const int id;
    const uint64_t serial;
    const std::shared_ptr<std::atomic<size_t>> live;
    Token(int host_id, uint64_t serial_id, std::shared_ptr<std::atomic<size_t>> counter)
        : id(host_id), serial(serial_id), live(std::move(counter)) { ++*live; }
    ~Token() { --*live; }
    Token(const Token&) = delete;
    Token& operator=(const Token&) = delete;
  };
  using Owner = std::shared_ptr<const Token>;
  using Retired = std::vector<std::shared_ptr<const Value>>;
  struct Admission {
    std::shared_ptr<const Value> value;
    bool cached = false;
  };
  struct Stats {
    size_t hosts, encodings, owners_alive, created, released;
    size_t cached_bytes, resident_bytes, retired_pin_bytes, cached_pin_bytes;
    size_t peak_resident_bytes, byte_limit, entry_limit, evictions, admissions;
    size_t rejections, pinned_rejections, oversized_rejections, shared_rejections;
    size_t stale_rejections, host_index_estimate_bytes;
  };

  explicit CaptureHostRegistry(size_t entries_per_host = 256,
                               size_t byte_limit = 64 * 1024 * 1024,
                               size_t entry_limit = 512,
                               size_t entry_index_charge = 512)
      : entries_per_host_(entries_per_host), byte_limit_(byte_limit),
        entry_limit_(entry_limit), entry_index_charge_(entry_index_charge),
        live_(std::make_shared<std::atomic<size_t>>(0)),
        ledger_(std::make_shared<Ledger>()) {}

  Owner Acquire(int host) {
    std::lock_guard lock(mutex_);
    auto found = hosts_.find(host);
    if (found != hosts_.end()) return found->second->owner;
    auto entry = std::make_unique<Entry>();
    entry->owner = std::make_shared<Token>(host, ++serial_, live_);
    auto result = entry->owner; hosts_.emplace(host, std::move(entry));
    ++created_; return result;
  }
  bool Contains(int host) const {
    std::lock_guard lock(mutex_); return hosts_.contains(host);
  }
  std::shared_ptr<const Value> Lookup(const Owner& owner, uint64_t key) {
    std::lock_guard lock(mutex_);
    if (!Current(owner)) return {};
    auto found = index_.find({owner->serial, key});
    if (found == index_.end()) return {};
    lru_.splice(lru_.begin(), lru_, found->second);
    return found->second->value;
  }

  // Transfer a fresh, uniquely owned value, then use only the returned alias.
  // A failed admission still returns the original value for this capture's
  // complete-byte response; it must not be advertised as a cache/hash hit.
  Admission Store(const Owner& owner, uint64_t key,
                  std::shared_ptr<const Value> value, size_t retained_bytes) {
    if (!key || !value) return {std::move(value), false};
    // Bound eviction work under concurrent writers. No destructor, encoding
    // or wait for external pins runs while holding the registry mutex.
    for (size_t attempt = 0; attempt <= entry_limit_; ++attempt) {
      std::shared_ptr<const Value> retired;
      {
        std::lock_guard lock(mutex_);
        auto* entry = Current(owner);
        if (!entry) { ++stale_rejections_; return Reject(std::move(value)); }
        const Key identity{owner->serial, key};
        auto existing = index_.find(identity);
        if (existing != index_.end() && existing->second->value.get() == value.get()) {
          lru_.splice(lru_.begin(), lru_, existing->second);
          return {existing->second->value, true};
        }
        if (!entries_per_host_ || !entry_limit_ ||
            entry_index_charge_ > byte_limit_ ||
            retained_bytes > byte_limit_ - entry_index_charge_) {
          ++oversized_rejections_; return Reject(std::move(value));
        }
        // Aliases created outside admission would escape the lifetime ledger.
        // Production transfers fresh encodings; returned Lookup aliases may
        // be re-touched under the same key via the branch above.
        if (value.use_count() != 1) {
          ++shared_rejections_; return Reject(std::move(value));
        }
        const size_t charge = retained_bytes + entry_index_charge_;
        auto victim = lru_.end();
        if (existing != index_.end()) victim = existing->second;
        else if (entry->encodings >= entries_per_host_) {
          for (auto it = lru_.end(); it != lru_.begin();) {
            --it; if (it->key.first == owner->serial) { victim = it; break; }
          }
        } else if (lru_.size() >= entry_limit_ ||
                   ledger_->resident.load() > byte_limit_ - charge) {
          if (!lru_.empty()) victim = std::prev(lru_.end());
          else { ++pinned_rejections_; return Reject(std::move(value)); }
        }
        if (victim != lru_.end()) {
          retired = Detach(victim); ++evictions_;
        } else {
          auto allocation = std::make_shared<Allocation>(
              std::move(value), charge, ledger_);
          std::shared_ptr<const Value> alias(allocation, allocation->value.get());
          lru_.push_front({identity, owner->id, alias, charge});
          index_.emplace(identity, lru_.begin());
          ++entry->encodings; cached_bytes_ += charge; ++admissions_;
          return {std::move(alias), true};
        }
      }
      // A cache-only value can now free its payload and reservation. A value
      // pinned by another snapshot stays charged, forcing another cold victim
      // or a finite uncached fallback rather than waiting for that snapshot.
      retired.reset();
    }
    std::lock_guard lock(mutex_);
    ++pinned_rejections_; return Reject(std::move(value));
  }

  Retired Release(int host) {
    Retired retired;
    {
      std::lock_guard lock(mutex_);
      auto found = hosts_.find(host); if (found == hosts_.end()) return {};
      const auto serial = found->second->owner->serial;
      for (auto it = lru_.begin(); it != lru_.end();) {
        auto current = it++;
        if (current->key.first == serial) retired.push_back(Detach(current));
      }
      hosts_.erase(found); ++released_;
    }
    // Caller drops aliases after releasing any surrounding capture lock.
    return retired;
  }
  Stats stats() const {
    std::lock_guard lock(mutex_);
    const size_t resident = ledger_->resident.load();
    size_t pinned = 0;
    for (const auto& entry : lru_)
      if (entry.value.use_count() > 1) pinned += entry.charge;
    return {hosts_.size(), lru_.size(), live_->load(), created_, released_,
            cached_bytes_, resident, resident - cached_bytes_, pinned,
            ledger_->peak.load(), byte_limit_, entry_limit_, evictions_, admissions_,
            rejections_, pinned_rejections_, oversized_rejections_, shared_rejections_,
            stale_rejections_, hosts_.size() * 256};
  }

 private:
  struct Ledger { std::atomic<size_t> resident{0}, peak{0}; };
  struct Allocation {
    std::shared_ptr<const Value> value;
    const size_t charge;
    const std::shared_ptr<Ledger> ledger;
    Allocation(std::shared_ptr<const Value> payload, size_t bytes,
               std::shared_ptr<Ledger> counter)
        : value(std::move(payload)), charge(bytes), ledger(std::move(counter)) {
      const auto total=ledger->resident.fetch_add(charge)+charge;
      auto peak=ledger->peak.load();
      while(peak<total&&!ledger->peak.compare_exchange_weak(peak,total)){}
    }
    ~Allocation() {
      value.reset();  // Free owned payload before returning its byte credit.
      ledger->resident.fetch_sub(charge);
    }
  };
  struct Entry { Owner owner; size_t encodings = 0; };
  using Key = std::pair<uint64_t, uint64_t>;
  struct Cached { Key key; int host; std::shared_ptr<const Value> value; size_t charge; };
  using Iterator = typename std::list<Cached>::iterator;
  Entry* Current(const Owner& owner) const {
    if (!owner) return nullptr;
    auto found = hosts_.find(owner->id);
    return found != hosts_.end() && found->second->owner.get() == owner.get()
        ? found->second.get() : nullptr;
  }
  std::shared_ptr<const Value> Detach(Iterator it) {
    auto value = std::move(it->value);
    auto host = hosts_.find(it->host);
    if (host != hosts_.end() && host->second->owner->serial == it->key.first)
      --host->second->encodings;
    cached_bytes_ -= it->charge; index_.erase(it->key); lru_.erase(it);
    return value;
  }
  Admission Reject(std::shared_ptr<const Value> value) {
    ++rejections_; return {std::move(value), false};
  }
  const size_t entries_per_host_, byte_limit_, entry_limit_, entry_index_charge_;
  const std::shared_ptr<std::atomic<size_t>> live_;
  const std::shared_ptr<Ledger> ledger_;
  mutable std::mutex mutex_;
  std::map<int, std::unique_ptr<Entry>> hosts_;
  std::list<Cached> lru_;
  std::map<Key, Iterator> index_;
  uint64_t serial_ = 0;
  size_t created_ = 0, released_ = 0, cached_bytes_ = 0;
  size_t evictions_ = 0, admissions_ = 0, rejections_ = 0, pinned_rejections_ = 0;
  size_t oversized_rejections_ = 0, shared_rejections_ = 0, stale_rejections_ = 0;
};
}  // namespace remote_paint
#endif
