#ifndef COMPONENTS_REMOTE_PAINT_SUBSCRIPTION_STATE_H_
#define COMPONENTS_REMOTE_PAINT_SUBSCRIPTION_STATE_H_
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>
#include <string_view>
#include <type_traits>

namespace remote_paint {
// Scalar subscription ownership only. The caller serializes access under the
// capture-state lock and owns every picture,encoded buffer and callback.
class SubscriptionState {
 public:
  static constexpr size_t kSlots = 4;
  static constexpr uint64_t kMaxSafeInteger = (uint64_t{1} << 53) - 1;
  static constexpr uint64_t kDefaultOrdinalSpan = uint64_t{1} << 32;
  struct Key {
    std::array<char,32> bytes{};
    bool operator==(const Key&) const = default;
    std::string_view view() const { return {bytes.data(),bytes.size()}; }
    bool valid() const {
      for(char c:bytes)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;
      return true;
    }
    static std::optional<Key> Parse(std::string_view value) {
      if(value.size()!=32)return std::nullopt;
      Key key;std::copy(value.begin(),value.end(),key.bytes.begin());
      return key.valid()?std::optional<Key>(key):std::nullopt;
    }
  };
  struct Context {
    uint64_t page_epoch=0,viewport_version=0,input_seq=0;
    uint32_t css_width=0,css_height=0;
    bool operator==(const Context&) const = default;
    bool valid() const {
      return page_epoch>0&&page_epoch<=kMaxSafeInteger&&
        viewport_version>0&&viewport_version<=kMaxSafeInteger&&input_seq<=kMaxSafeInteger&&
        css_width>0&&css_width<=4096&&css_height>0&&css_height<=4096;
    }
    bool SameTarget(const Context& other) const {
      return page_epoch==other.page_epoch&&viewport_version==other.viewport_version&&
        css_width==other.css_width&&css_height==other.css_height;
    }
  };
  enum class Phase { Idle,Recording,AwaitingCredit };
  enum class BindStatus { Bound,Existing,Invalid,Busy,Full,Exhausted };
  enum class TakeStatus { Taken,Missing,Inactive,Busy,Exhausted,BeforeCommit,NotDue };
  enum class Outcome { Consumed,Retry,Pause };
  enum class Completion { Ignored,Released,Retired };
  struct Snapshot {
    Key key;Context context;
    int host=0;
    int minimum_source_frame=0;
    uint64_t generation=0,ordinal_base=0,ordinal_limit=0,last_started=0;
    uint64_t resource_revision=1,inflight_ordinal=0;
    uint64_t interval_us=0,heartbeat_us=0,last_started_us=0,last_request_us=0;
    Phase phase=Phase::Idle;
    bool occupied=false,enabled=false,retiring=false,exhausted=false;
    bool full_resources=true,needs_frame=false;
    bool has_started=false,pending_damage=false;
  };
  struct Ticket {
    Key key;Context context;
    uint64_t generation=0,ordinal=0,resource_revision=0;
    int host=0;
    uint8_t slot=0;
    bool full_resources=false;
    // Exact Take admission on Chromium's TimeTicks clock. This value travels
    // with the job; later input, retries or scheduling cannot retime a frame.
    uint64_t capture_started_us=0;
  };
  struct BindResult { BindStatus status;std::optional<Snapshot> snapshot; };
  struct TakeResult { TakeStatus status;std::optional<Ticket> ticket;bool schedule_changed=false; };
  struct Stats { size_t bindings=0,enabled=0,inflight=0,retiring=0;uint64_t next_base=0; };

  explicit SubscriptionState(uint64_t ordinal_span=kDefaultOrdinalSpan)
      : span_(ordinal_span),configured_(ordinal_span>=2&&
          ordinal_span<=kMaxSafeInteger&&(ordinal_span&(ordinal_span-1))==0) {}
  // A range is reserved at bind time,not from the last delivered frame. The
  // backend carries ordinal_limit+1 across renderer replacement,so frames
  // already encoding/inIPC cannot be mistaken for a newer binding's work.
  BindResult Bind(int host,const Key& key,const Context& context,
                  uint64_t minimum_base=0,int minimum_source_frame=0) {
    if(!configured_||host<=0||!key.valid()||!context.valid()||minimum_base>kMaxSafeInteger||minimum_source_frame<0)
      return {BindStatus::Invalid,std::nullopt};
    for(const auto& entry:entries_)if(entry.occupied&&(entry.host==host||entry.key==key)) {
      if(entry.host==host&&entry.key==key&&!entry.retiring&&
         entry.context.SameTarget(context)&&minimum_base<=entry.ordinal_base)
        return {BindStatus::Existing,entry};
      return {BindStatus::Busy,std::nullopt};
    }
    auto found=std::find_if(entries_.begin(),entries_.end(),[](const auto& e){return !e.occupied;});
    if(found==entries_.end())return {BindStatus::Full,std::nullopt};
    uint64_t base=std::max(next_base_,minimum_base),remainder=base%span_;
    if(remainder) {
      const auto padding=span_-remainder;
      if(base>kMaxSafeInteger-padding)return {BindStatus::Exhausted,std::nullopt};
      base+=padding;
    }
    if(base>kMaxSafeInteger-(span_-1)||next_generation_>kMaxSafeInteger)
      return {BindStatus::Exhausted,std::nullopt};
    Snapshot entry;entry.occupied=true;entry.host=host;entry.key=key;entry.context=context;
    entry.minimum_source_frame=minimum_source_frame;
    entry.generation=next_generation_++;entry.ordinal_base=base;
    entry.ordinal_limit=base+span_-1;entry.last_started=base;
    *found=entry;next_base_=entry.ordinal_limit+1;
    return {BindStatus::Bound,entry};
  }
  std::optional<Snapshot> Inspect(int host,const Key& key) const {
    const auto* entry=Find(host,key);return entry?std::optional<Snapshot>(*entry):std::nullopt;
  }
  bool HasHost(int host) const {
    return std::any_of(entries_.begin(),entries_.end(),[host](const auto& e){return e.occupied&&e.host==host;});
  }
  bool Update(int host,const Key& key,uint64_t input_seq,bool full_resources,
              bool request_frame=true,int minimum_source_frame=0,uint64_t now_us=0) {
    auto* entry=Find(host,key);
    if(!entry||entry->retiring||entry->exhausted||input_seq<entry->context.input_seq||
       input_seq>kMaxSafeInteger||minimum_source_frame<0||(full_resources&&entry->resource_revision==std::numeric_limits<uint64_t>::max()))return false;
    entry->context.input_seq=input_seq;
    entry->minimum_source_frame=std::max(entry->minimum_source_frame,minimum_source_frame);
    if(full_resources)RequireFull(*entry);
    if(request_frame&&entry->enabled){entry->needs_frame=true;entry->last_request_us=now_us;}
    return true;
  }
  bool SetEnabled(int host,const Key& key,bool enabled,int minimum_source_frame=0,uint64_t now_us=0) {
    auto* entry=Find(host,key);
    if(!entry||entry->retiring||entry->exhausted||minimum_source_frame<0)return false;
    if(enabled)entry->minimum_source_frame=std::max(entry->minimum_source_frame,minimum_source_frame);
    if(entry->enabled==enabled)return true;
    if(entry->resource_revision==std::numeric_limits<uint64_t>::max())return false;
    RequireFull(*entry);entry->enabled=enabled;entry->needs_frame=enabled;
    if(enabled)entry->last_request_us=now_us;
    return true;
  }
  // The caller uses one renderer main-sequence timer. All scheduling state is
  // inline and uses monotonic microseconds; no task/frame/picture owner lives
  // here. A zero heartbeat preserves the diagnostic one-shot-era behavior.
  bool SetCadence(int host,const Key& key,uint64_t interval_us,uint64_t heartbeat_us,uint64_t now_us=0) {
    auto* entry=Find(host,key);
    if(!entry||entry->retiring||heartbeat_us==0||heartbeat_us>1'000'000||interval_us>heartbeat_us)return false;
    entry->interval_us=interval_us;entry->heartbeat_us=heartbeat_us;
    if(entry->needs_frame)entry->last_request_us=now_us;return true;
  }
  std::optional<uint64_t> NextDelay(uint64_t now_us) const {
    std::optional<uint64_t> delay;
    for(const auto& entry:entries_) {
      if(!entry.occupied||!entry.enabled||entry.retiring||!entry.heartbeat_us||entry.phase!=Phase::Idle)continue;
      // Enable/input/retry already requested a frame. A bounded heartbeat
      // retry is sufficient while its clock/commit is pending; never spin.
      const auto due=entry.needs_frame||!entry.has_started?Remaining(entry.heartbeat_us,Since(entry.last_request_us,now_us)):
          Remaining(entry.pending_damage?entry.interval_us:entry.heartbeat_us,Elapsed(entry,now_us));
      delay=delay?std::min(*delay,due):due;
    }
    return delay;
  }
  bool RequestDue(int host,const Key& key,uint64_t now_us) {
    auto* entry=Find(host,key);
    if(!entry||!entry->enabled||entry->retiring||!entry->heartbeat_us||entry->phase!=Phase::Idle)return false;
    const auto elapsed=Elapsed(*entry,now_us);
    if((entry->needs_frame||!entry->has_started)&&Since(entry->last_request_us,now_us)<entry->heartbeat_us)return false;
    if(entry->has_started&&!entry->needs_frame&&
       !(entry->pending_damage&&elapsed>=entry->interval_us)&&elapsed<entry->heartbeat_us)return false;
    entry->needs_frame=true;entry->last_request_us=now_us;return true;
  }
  TakeResult Take(int host,int source_frame=std::numeric_limits<int>::max(),bool damaged=true,uint64_t now_us=0) {
    auto found=std::find_if(entries_.begin(),entries_.end(),[host](const auto& e){return e.occupied&&e.host==host;});
    if(found==entries_.end())return {TakeStatus::Missing,std::nullopt};
    auto& entry=*found;
    if(entry.exhausted)return {TakeStatus::Exhausted,std::nullopt};
    if(!entry.enabled||entry.retiring)return {TakeStatus::Inactive,std::nullopt};
    const bool changed=entry.heartbeat_us&&damaged&&!entry.pending_damage;
    if(changed)entry.pending_damage=true;
    // Damage during encoding/credit remains pending for the next real frame.
    if(entry.phase!=Phase::Idle)return {TakeStatus::Busy,std::nullopt,changed};
    // Main-thread context updates must reach the activated compositor tree
    // before their new epoch/input watermark can label any recording. A
    // compositor-only animation may otherwise still draw the preceding tree.
    if(source_frame<entry.minimum_source_frame)return {TakeStatus::BeforeCommit,std::nullopt,changed};
    if(entry.heartbeat_us&&entry.has_started&&!entry.needs_frame) {
      const auto elapsed=Elapsed(entry,now_us);
      if(elapsed<entry.interval_us||(!entry.pending_damage&&elapsed<entry.heartbeat_us))
        return {TakeStatus::NotDue,std::nullopt,changed};
    }
    if(entry.last_started==entry.ordinal_limit) {
      entry.exhausted=true;entry.enabled=false;entry.needs_frame=false;
      return {TakeStatus::Exhausted,std::nullopt,true};
    }
    entry.inflight_ordinal=++entry.last_started;entry.phase=Phase::Recording;entry.needs_frame=false;
    entry.last_started_us=now_us;entry.has_started=true;entry.pending_damage=false;
    return {TakeStatus::Taken,Ticket{entry.key,entry.context,entry.generation,
      entry.inflight_ordinal,entry.resource_revision,entry.host,
      static_cast<uint8_t>(found-entries_.begin()),entry.full_resources,now_us},entry.heartbeat_us!=0};
  }
  // This is admission to publishing,not final credit. Cancellation can race
  // already-admitted IPC;the Broker mustalso validate the active scope.
  bool BeginPublish(const Ticket& ticket) {
    auto* entry=Match(ticket);
    if(!entry||!entry->enabled||entry->retiring||entry->phase!=Phase::Recording)return false;
    entry->phase=Phase::AwaitingCredit;return true;
  }
  // Consumed means successful Broker mapping/publication after validation,
  // never socketwrite or a superseded/rejected frame. Failure also retires the
  // exact native job;it cannot silently retain or release another job's slot.
  Completion Finish(const Ticket& ticket,Outcome outcome,uint64_t now_us=0) {
    auto* entry=Match(ticket);
    if(!entry||(outcome==Outcome::Consumed&&entry->phase!=Phase::AwaitingCredit))return Completion::Ignored;
    if(entry->retiring){*entry=Snapshot{};return Completion::Retired;}
    entry->phase=Phase::Idle;entry->inflight_ordinal=0;
    if(outcome==Outcome::Consumed) {
      if(ticket.full_resources&&ticket.resource_revision==entry->resource_revision)
        entry->full_resources=false;
    } else {
      if(entry->resource_revision==std::numeric_limits<uint64_t>::max()) {
        entry->enabled=false;entry->exhausted=true;
      } else RequireFull(*entry);
      if(outcome==Outcome::Pause)entry->enabled=false;
      entry->needs_frame=entry->enabled;
      if(entry->needs_frame)entry->last_request_us=now_us;
    }
    return Completion::Released;
  }
  bool Cancel(int host,const Key& key) {
    auto* entry=Find(host,key);if(!entry)return false;
    Retire(*entry);return true;
  }
  bool RetireHost(int host) {
    for(auto& entry:entries_)if(entry.occupied&&entry.host==host){Retire(entry);return true;}
    return false;
  }
  Stats stats() const {
    Stats out;out.next_base=next_base_;
    for(const auto& entry:entries_)if(entry.occupied){out.bindings++;out.enabled+=entry.enabled;
      out.inflight+=entry.phase!=Phase::Idle;out.retiring+=entry.retiring;}
    return out;
  }
 private:
  static uint64_t Elapsed(const Snapshot& entry,uint64_t now_us) {
    return Since(entry.last_started_us,now_us);
  }
  static uint64_t Since(uint64_t before,uint64_t now_us) {
    return now_us>=before?now_us-before:0;
  }
  static uint64_t Remaining(uint64_t interval,uint64_t elapsed) {
    return elapsed>=interval?0:interval-elapsed;
  }
  Snapshot* Find(int host,const Key& key) {
    for(auto& entry:entries_)if(entry.occupied&&entry.host==host&&entry.key==key)return &entry;
    return nullptr;
  }
  const Snapshot* Find(int host,const Key& key) const {
    for(const auto& entry:entries_)if(entry.occupied&&entry.host==host&&entry.key==key)return &entry;
    return nullptr;
  }
  Snapshot* Match(const Ticket& ticket) {
    if(ticket.slot>=entries_.size())return nullptr;
    auto& e=entries_[ticket.slot];
    return e.occupied&&e.phase!=Phase::Idle&&e.host==ticket.host&&e.key==ticket.key&&
      e.generation==ticket.generation&&e.inflight_ordinal==ticket.ordinal?&e:nullptr;
  }
  static void RequireFull(Snapshot& entry) { entry.full_resources=true;entry.resource_revision++; }
  static void Retire(Snapshot& entry) {
    if(entry.phase==Phase::Idle){entry=Snapshot{};return;}
    entry.enabled=false;entry.retiring=true;entry.needs_frame=false;
  }
  std::array<Snapshot,kSlots> entries_{};
  const uint64_t span_;
  uint64_t next_base_=0,next_generation_=1;
  const bool configured_;
};
static_assert(std::is_trivially_copyable_v<SubscriptionState::Key>);
static_assert(std::is_trivially_copyable_v<SubscriptionState::Context>);
static_assert(std::is_trivially_copyable_v<SubscriptionState::Ticket>);
static_assert(sizeof(SubscriptionState)<=2048,"Subscription registry must remain fixed scalar metadata");
}  // namespace remote_paint
#endif
