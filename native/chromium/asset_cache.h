#ifndef COMPONENTS_REMOTE_PAINT_ASSET_CACHE_H_
#define COMPONENTS_REMOTE_PAINT_ASSET_CACHE_H_

#include <condition_variable>
#include <cstddef>
#include <list>
#include <iterator>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <utility>

namespace remote_paint {

// The caller owns synchronization. Evicting a cache reference never invalidates
// an immutable asset already pinned by a serializer or an IPC packet.
template <typename Key, typename Value>
class AssetLru {
 public:
  AssetLru(size_t byte_limit, size_t entry_limit)
      : byte_limit_(byte_limit), entry_limit_(entry_limit) {}

  template <typename Match>
  std::shared_ptr<const Value> Find(const Key& key, Match match) {
    auto exact = index_.find(key);
    if (exact != index_.end()) return Touch(exact->second);
    for (auto it = entries_.begin(); it != entries_.end(); ++it)
      if (match(it->key, *it->value)) return Touch(it);
    return {};
  }

  bool Insert(const Key& key, std::shared_ptr<const Value> value, size_t charge) {
    if (!value || !entry_limit_ || charge > byte_limit_) return false;
    auto previous = index_.find(key);
    if (previous != index_.end()) Remove(previous->second, false);
    // Subtract before comparing so even SIZE_MAX charges cannot overflow.
    while (!entries_.empty() &&
           (entries_.size() >= entry_limit_ || bytes_ > byte_limit_ - charge))
      Remove(std::prev(entries_.end()), true);
    entries_.push_front({key, std::move(value), charge});
    index_.emplace(key, entries_.begin());
    bytes_ += charge;
    return true;
  }

  void Clear() { index_.clear(); entries_.clear(); bytes_ = 0; evictions_ = 0; }
  size_t bytes() const { return bytes_; }
  size_t size() const { return entries_.size(); }
  size_t evictions() const { return evictions_; }

 private:
  struct Entry { Key key; std::shared_ptr<const Value> value; size_t charge; };
  using Iterator = typename std::list<Entry>::iterator;
  std::shared_ptr<const Value> Touch(Iterator it) {
    auto result = it->value;
    entries_.splice(entries_.begin(), entries_, it);
    return result;
  }
  void Remove(Iterator it, bool evicted) {
    bytes_ -= it->charge;
    index_.erase(it->key);
    entries_.erase(it);
    if (evicted) ++evictions_;
  }
  const size_t byte_limit_, entry_limit_;
  size_t bytes_ = 0, evictions_ = 0;
  std::list<Entry> entries_;
  std::map<Key, Iterator> index_;
};

// Cache lookup and exact-key job registration are atomic. Encoding and waiting
// happen outside the cache lock. A bounded job table shares success and failure
// with current waiters; failures are never cached and a later request may retry.
template <typename Key, typename Value>
class AssetMemo {
 public:
  struct Result {
    std::shared_ptr<const Value> value;
    bool cache_hit = false, shared_encoding = false;
  };
  struct Stats {
    size_t bytes, entries, evictions, pending, encodes, shares, bypasses;
  };
  AssetMemo(size_t byte_limit, size_t entry_limit, size_t pending_limit = 32)
      : cache_(byte_limit, entry_limit), pending_limit_(pending_limit) {}

  template <typename Match, typename Encode, typename Charge>
  Result Get(const Key& key, Match match, Encode encode, Charge charge) {
    std::shared_ptr<Pending> pending;
    bool owner = false;
    {
      std::lock_guard lock(mutex_);
      if (auto value = cache_.Find(key, match)) return {value, true, false};
      auto found = jobs_.find(key);
      if (found != jobs_.end()) { pending = found->second; ++shares_; }
      else {
        owner = true; ++encodes_; ++active_;
        if (jobs_.size() < pending_limit_) {
          pending = std::make_shared<Pending>(); jobs_.emplace(key, pending);
        } else ++bypasses_;
      }
    }
    if (!owner) {
      std::unique_lock lock(pending->mutex);
      pending->ready.wait(lock, [&] { return pending->done; });
      return {pending->value, false, true};
    }
    // The pending-table cap bounds bookkeeping, not the existing worker pool.
    // At saturation an unregistered key is encoded without waiting for a slot.
    // Existing same-key jobs still share above, and no result is truncated.
    auto value = encode();
    const std::optional<size_t> retained = value ? charge(*value) : std::nullopt;
    {
      std::lock_guard lock(mutex_);
      if (retained) cache_.Insert(key, value, *retained);
      if (pending) jobs_.erase(key);
      --active_;
    }
    if (pending) {
      { std::lock_guard lock(pending->mutex);
        pending->value = value; pending->done = true; }
      pending->ready.notify_all();
    }
    return {std::move(value), false, false};
  }

  Stats stats() const {
    std::lock_guard lock(mutex_);
    return {cache_.bytes(), cache_.size(), cache_.evictions(), jobs_.size(),
            encodes_, shares_, bypasses_};
  }
  bool ClearForTesting() {
    std::lock_guard lock(mutex_);
    if (active_) return false;
    cache_.Clear(); encodes_ = shares_ = bypasses_ = 0; return true;
  }

 private:
  struct Pending {
    std::mutex mutex;
    std::condition_variable ready;
    bool done = false;
    std::shared_ptr<const Value> value;
  };
  mutable std::mutex mutex_;
  AssetLru<Key, Value> cache_;
  const size_t pending_limit_;
  std::map<Key, std::shared_ptr<Pending>> jobs_;
  size_t encodes_ = 0, shares_ = 0, bypasses_ = 0;
  size_t active_ = 0;
};
}  // namespace remote_paint
#endif
