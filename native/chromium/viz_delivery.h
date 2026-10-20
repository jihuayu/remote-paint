#ifndef COMPONENTS_REMOTE_PAINT_VIZ_DELIVERY_H_
#define COMPONENTS_REMOTE_PAINT_VIZ_DELIVERY_H_

#include <cassert>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <iterator>
#include <list>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <utility>

namespace remote_paint {
// The owner serializes these operations under its lock. One writer owns the
// active packet; queued/reserved packets share the same two-packet budget.
// A fault replaces queued bytes with one seven-byte receipt. The receiver
// rejects its outstanding expectations explicitly instead of waiting for a
// scene that was silently discarded. Failed/unwritten IDs never enter history.
class VizDeliveryQueue {
 public:
  enum class Fault : uint8_t { kNone = 0, kOverloaded = 1, kTransport = 2 };
  struct Packet {
    std::string id;
    std::string bytes;
    Fault fault = Fault::kNone;
  };
  explicit VizDeliveryQueue(size_t capacity = 2, size_t history = 256);
  ~VizDeliveryQueue();
  VizDeliveryQueue(const VizDeliveryQueue&) = delete;
  VizDeliveryQueue& operator=(const VizDeliveryQueue&) = delete;

  bool Reserve(const std::string& id) {
    if (pending_.contains(id)) return false;
    auto old = delivered_.find(id);
    if (old != delivered_.end()) {
      history_.splice(history_.end(), history_, old->second);
      return false;
    }
    if (failed_) {
      // The receiver may already have consumed the active fault before this
      // new ID was registered. Cover it with a subsequent receipt as well.
      fault_dirty_ = true;
      return false;
    }
    if (pending_.size() >= capacity_) {
      Fail(Fault::kOverloaded);
      return false;
    }
    pending_.insert(id);
    return true;
  }
  void Submit(const std::string& id, std::string bytes) {
    // A concurrent transport failure may have canceled this reservation while
    // the display sequence was serializing it. Its fault receipt covers it.
    if (failed_ || !pending_.contains(id)) return;
    assert(bytes.size() <= 256 * 1024);
    queued_.push_back({id, std::move(bytes)});
  }
  std::optional<Packet> Take() {
    assert(!active_);
    if (queued_.empty()) return std::nullopt;
    auto packet = std::move(queued_.front());
    queued_.pop_front();
    active_ = packet.id;
    active_fault_ = packet.fault;
    if (active_fault_ != Fault::kNone) fault_dirty_ = false;
    active_bytes_ = packet.bytes.size();
    return packet;
  }
  void Complete(bool written) {
    assert(active_);
    if (active_fault_ != Fault::kNone) {
      if (written && fault_dirty_) {
        queued_.push_back(FaultPacket(active_fault_));
      } else {
        failed_ = false;
      }
    } else {
      pending_.erase(*active_);
      if (written) {
        history_.push_back(*active_);
        delivered_.emplace(*active_, std::prev(history_.end()));
        if (history_.size() > history_limit_) {
          delivered_.erase(history_.front());
          history_.pop_front();
        }
      } else {
        Fail(Fault::kTransport);
      }
    }
    active_.reset();
    active_bytes_ = 0;
    active_fault_ = Fault::kNone;
  }
  bool ready() const { return !queued_.empty(); }
  size_t pending() const { return pending_.size(); }
  size_t history_size() const { return delivered_.size(); }
  size_t buffered_bytes() const {
    size_t bytes = active_bytes_;
    for (const auto& packet : queued_) bytes += packet.bytes.size();
    return bytes;
  }

 private:
  static Packet FaultPacket(Fault fault) {
    std::string bytes("RVE2\x01\x01", 6);
    bytes.push_back(static_cast<char>(fault));
    return {{}, std::move(bytes), fault};
  }
  void Fail(Fault fault) {
    if (failed_) return;
    failed_ = true;
    pending_.clear();
    queued_.clear();
    fault_dirty_ = false;
    queued_.push_back(FaultPacket(fault));
  }
  const size_t capacity_, history_limit_;
  std::set<std::string> pending_;
  std::deque<Packet> queued_;
  std::optional<std::string> active_;
  Fault active_fault_ = Fault::kNone;
  size_t active_bytes_ = 0;
  bool failed_ = false;
  bool fault_dirty_ = false;
  std::list<std::string> history_;
  std::map<std::string, std::list<std::string>::iterator> delivered_;
};
}  // namespace remote_paint
#endif
