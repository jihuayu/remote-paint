#include "components/remote_paint/capture_state.h"
#include "components/remote_paint/canvas_capture.h"
#include "components/remote_paint/recording_index.h"
#include "components/remote_paint/capture_frame_marker.h"
#include <algorithm>
#include <atomic>
#include <map>
#include <set>
#include <utility>
#include "base/base64.h"
#include "base/environment.h"
#include "base/barrier_callback.h"
#include "base/compiler_specific.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/logging.h"
#include "base/process/process_handle.h"
#include "base/strings/string_number_conversions.h"
#include "base/synchronization/lock.h"
#include "base/task/thread_pool.h"
#include "base/task/bind_post_task.h"
#include "base/threading/platform_thread.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "components/remote_paint/serializer.h"
#include "components/remote_paint/socket_transport.h"
#include "base/json/json_writer.h"
#include "crypto/sha2.h"
namespace remote_paint {
namespace {
struct SubscriptionBinding {
  uintptr_t document=0;
  int world=0,host=0;
  SubscriptionState::Key key;
  base::RepeatingClosure wake;
};
struct State {
  base::Lock lock;
  std::atomic<int> pending{0};
  std::atomic<bool> has_frame_markers{false};
  CaptureFrameMarkers frame_markers;
  std::map<std::pair<int,int>,std::array<int,4>> damages;
  std::map<int,std::unique_ptr<CaptureRequest>> requests;
  CaptureHostRegistry<EncodedPicture> hosts;
  SubscriptionState subscriptions;
  std::array<SubscriptionBinding,SubscriptionState::kSlots> bindings;
  std::atomic<bool> subscriptions_enabled{false};
  // One pending arm task and one main-sequence timer per renderer. Neither
  // captures a document, V8 context, picture or in-flight resource owner.
  base::RepeatingClosure schedule_arm;
  bool schedule_arm_posted=false,timer_running=false;
  uint64_t timer_due_us=0,timer_ticks=0,timer_arms=0,timer_wakes=0;
  // Covers queued AND encoding legacy requests, so isolated contexts cannot
  // overlap a persistent job or bypass the renderer's four-job bound.
  std::map<int,std::string> legacy_jobs;
};
State& GetState(){static base::NoDestructor<State> state;return *state;}
uint64_t ScheduleNow(){return static_cast<uint64_t>(base::TimeTicks::Now().since_origin().InMicroseconds());}
void ArmNativeSchedule();
void TickNativeSchedule();
// Constructed/used only from the renderer's script/main sequence, never the
// compositor or encoder which may initialize the shared State first.
base::OneShotTimer& NativeScheduleTimer(){static base::NoDestructor<base::OneShotTimer> timer;return *timer;}
base::RepeatingClosure RequestScheduleArmLocked(State& state){
  if(!state.schedule_arm||state.schedule_arm_posted)return {};
  state.schedule_arm_posted=true;return state.schedule_arm;
}
void ApplyNativeSchedule(){
  std::optional<uint64_t> delay;
  {auto& state=GetState();base::AutoLock lock(state.lock);const auto now=ScheduleNow();
    delay=state.subscriptions.NextDelay(now);
    // Bound zero-deadline retries; the clock/commit still owns frame delivery.
    if(delay)*delay=std::max<uint64_t>(1000,*delay);
    state.timer_running=delay.has_value();state.timer_due_us=delay?now+*delay:0;state.timer_arms++;
  }
  auto& timer=NativeScheduleTimer();
  if(delay)timer.Start(FROM_HERE,base::Microseconds(static_cast<int64_t>(*delay)),base::BindOnce(&TickNativeSchedule));
  else timer.Stop();
}
void ArmNativeSchedule(){
  {auto& state=GetState();base::AutoLock lock(state.lock);state.schedule_arm_posted=false;}
  ApplyNativeSchedule();
}
void TickNativeSchedule(){
  std::array<base::RepeatingClosure,SubscriptionState::kSlots> wakes;
  {auto& state=GetState();base::AutoLock lock(state.lock);const auto now=ScheduleNow();
    state.timer_running=false;state.timer_due_us=0;state.timer_ticks++;
    for(size_t n=0;n<state.bindings.size();n++){
      const auto& binding=state.bindings[n];
      if(binding.document&&state.subscriptions.RequestDue(binding.host,binding.key,now)){
        wakes[n]=binding.wake;state.timer_wakes++;
      }
    }
  }
  for(auto& wake:wakes)if(wake)wake.Run();
  // Do not clear schedule_arm_posted: a compositor change may already have
  // queued its single arm callback while this timer was running.
  ApplyNativeSchedule();
}
void RefreshSubscriptions(State& state) {
  state.subscriptions_enabled.store(state.subscriptions.stats().enabled>0,std::memory_order_relaxed);
}
SubscriptionBinding* FindBinding(State& state,int host,const SubscriptionState::Key& key) {
  for(auto& binding:state.bindings)if(binding.document&&binding.host==host&&binding.key==key)return &binding;
  return nullptr;
}
void FinishSubscription(const SubscriptionState::Ticket& ticket,SubscriptionState::Outcome outcome) {
  base::RepeatingClosure wake,arm;
  {auto& state=GetState();base::AutoLock lock(state.lock);
    const auto completion=state.subscriptions.Finish(ticket,outcome,ScheduleNow());
    if(completion==SubscriptionState::Completion::Ignored)return;
    auto* binding=FindBinding(state,ticket.host,ticket.key);
    const auto current=state.subscriptions.Inspect(ticket.host,ticket.key);
    if(binding&&current&&current->enabled&&current->needs_frame)wake=binding->wake;
    RefreshSubscriptions(state);
    arm=RequestScheduleArmLocked(state);
  }
  if(wake)wake.Run();
  if(arm)arm.Run();
}
void FinishLegacy(const CaptureRequest& request) {
  auto& state=GetState();base::AutoLock lock(state.lock);
  auto found=state.legacy_jobs.find(request.host);
  if(found!=state.legacy_jobs.end()&&found->second==request.capture_id)state.legacy_jobs.erase(found);
}
std::atomic<uint64_t>& NextRecordingKey(){static std::atomic<uint64_t> next{1};return next;}
bool NativeResourceIPC(){
  static const bool enabled=base::Environment::Create()->GetVar("REMOTE_PAINT_NATIVE_RESOURCES").value_or("")=="1";return enabled;
}
struct EncodedLayer {
  // Declared before payload so its alias/byte reservation outlives payload's
  // final SkData reference when an encoded layer is destroyed.
  std::shared_ptr<const EncodedPicture> encoded_owner;
  sk_sp<const SkData> payload;
  size_t index = 0;
  int local_id = 0;
  float quad_scale = 0;
  int width = 0;
  int height = 0;
  size_t bitmap_glyphs = 0;
  bool requires_isolation = false;
  size_t font_cache_hits=0,image_cache_hits=0;
  size_t font_encoding_shares=0,image_encoding_shares=0;
  bool tiled = false;
  int tile_x = 0, tile_y = 0;
  size_t byte_size = 0;
  std::string skp;
  std::string error;
  std::string thread;
  double portable_ms = 0;
  double glyph_collection_ms = 0;
  double serialize_ms = 0;
  double font_ms = 0;
  double image_ms = 0;
  double base64_ms = 0;
  std::vector<AssetRange> asset_ranges;
  bool asset_ranges_complete = false;
  bool reused = false;
  std::string resource_id;
};

EncodedLayer EncodeLayer(CaptureOwner owner, size_t index, LayerRecord record) {
  EncodedLayer result;
  result.index = index;
  result.tiled = record.tiled;result.tile_x=record.tile_x;result.tile_y=record.tile_y;
  result.local_id = record.local_id;
  result.quad_scale = record.quad_scale;
  if(!record.picture&&!record.encoded){result.error="Missing native recording and encoding";return result;}
  if(!record.picture&&(record.recording_width<=0||record.recording_height<=0)){result.error="Missing native recording geometry";return result;}
  result.width = record.recording_width>0?record.recording_width:record.picture->cullRect().width();
  result.height = record.recording_height>0?record.recording_height:record.picture->cullRect().height();
  result.thread = base::NumberToString(base::PlatformThread::CurrentId().raw());
  std::shared_ptr<const EncodedPicture> encoded=record.encoded;
  if(!encoded){
    auto serialized=SerializePicture(*record.picture,16*1024*1024,!record.transient_canvas);
    result.portable_ms = serialized.portable_ms;
    result.glyph_collection_ms = serialized.glyph_collection_ms;
    result.serialize_ms = serialized.serialize_ms;
    result.font_ms = serialized.font_ms;
    result.image_ms = serialized.image_ms;
    result.font_cache_hits=serialized.font_cache_hits;result.image_cache_hits=serialized.image_cache_hits;
    result.font_encoding_shares=serialized.font_encoding_shares;result.image_encoding_shares=serialized.image_encoding_shares;
    result.bitmap_glyphs = serialized.bitmap_glyphs;
    result.requires_isolation = serialized.requires_isolation;
    if(!serialized.bytes){
      result.error = serialized.error.empty() ? "Picture encoding failed" : serialized.error;
      return result;
    }
    auto mutable_encoded=std::make_shared<EncodedPicture>();
    mutable_encoded->serialized=std::move(serialized);
    const auto base64_started = base::TimeTicks::Now();
    if(!NativeResourceIPC())mutable_encoded->base64 = base::Base64Encode(UNSAFE_BUFFERS(
        base::span(mutable_encoded->serialized.bytes->bytes(),
                   mutable_encoded->serialized.bytes->size())));
    result.base64_ms = (base::TimeTicks::Now() - base64_started).InMillisecondsF();
    result.byte_size = mutable_encoded->serialized.bytes->size();
    auto digest=crypto::SHA256Hash(UNSAFE_BUFFERS(base::span<const uint8_t>(
        static_cast<const uint8_t*>(mutable_encoded->serialized.bytes->bytes()),
        mutable_encoded->serialized.bytes->size())));
    mutable_encoded->resource_id=base::HexEncodeLower(base::span(digest));
    encoded=std::move(mutable_encoded);
    encoded=StoreCachedEncoding(owner,record.recording_key,std::move(encoded));
  } else {
    result.byte_size = encoded->serialized.bytes->size();
    result.reused = true;
  }
  result.bitmap_glyphs = encoded->serialized.bitmap_glyphs;
  result.requires_isolation = record.transient_canvas || encoded->serialized.requires_isolation;
  if(!result.reused){
    result.portable_ms = encoded->serialized.portable_ms;
    result.glyph_collection_ms = encoded->serialized.glyph_collection_ms;
    result.serialize_ms = encoded->serialized.serialize_ms;
    result.font_ms = encoded->serialized.font_ms;
    result.image_ms = encoded->serialized.image_ms;
  }
  if(NativeResourceIPC())result.payload=encoded->serialized.bytes;
  result.skp = encoded->base64;
  result.asset_ranges=encoded->serialized.asset_ranges;
  result.asset_ranges_complete=encoded->serialized.asset_ranges_complete;
  result.resource_id = encoded->resource_id;
  result.encoded_owner = std::move(encoded);
  return result;
}

base::DictValue BuildResults(const Snapshot& snapshot,
                              std::vector<EncodedLayer>& layers) {
  std::sort(layers.begin(),layers.end(),[](const auto& a,const auto& b){return a.index<b.index;});
  const auto started = base::TimeTicks::Now();
  double portable_ms = 0, glyph_collection_ms = 0, serialize_ms = 0, font_ms = 0, image_ms = 0, base64_ms = 0;
  base::DictValue result;
  result.Set("captureId",snapshot.capture_id);
  base::ListValue webgl_layers;
  for (int layer : snapshot.webgl_layers) webgl_layers.Append(layer);
  result.Set("webglLayers", std::move(webgl_layers));
  result.Set("resourcesComplete",snapshot.force_resources);
  result.Set("producer",snapshot.producer);
  result.Set("frameToken",static_cast<double>(snapshot.frame_token));
  result.Set("sourceFrame",snapshot.source_frame);
  result.Set("recordingThread",snapshot.recording_thread);
  result.Set("encodingThread",base::NumberToString(base::PlatformThread::CurrentId().raw()));
  if(!snapshot.error.empty()){result.Set("error",snapshot.error);if(!snapshot.error_code.empty())result.Set("code",snapshot.error_code);return result;}
  base::ListValue resources;size_t total=0,font_cache_hits=0,image_cache_hits=0;std::set<std::string> threads;int cached_layers=0;
  size_t font_encoding_shares=0,image_encoding_shares=0;
  for(auto& encoded:layers){
    portable_ms += encoded.portable_ms;glyph_collection_ms += encoded.glyph_collection_ms;
    serialize_ms += encoded.serialize_ms;font_ms += encoded.font_ms;image_ms += encoded.image_ms;
    base64_ms += encoded.base64_ms;
    font_cache_hits+=encoded.font_cache_hits;image_cache_hits+=encoded.image_cache_hits;
    font_encoding_shares+=encoded.font_encoding_shares;image_encoding_shares+=encoded.image_encoding_shares;
    if(!encoded.error.empty()){
      result.Set("error",encoded.error);return result;
    }
    if((total+=encoded.byte_size)>64*1024*1024){
      result.Set("error","Frame byte budget exceeded");return result;
    }
    base::DictValue resource;
    resource.Set("localId",encoded.local_id);
    if(encoded.tiled){base::ListValue origin;origin.Append(encoded.tile_x);origin.Append(encoded.tile_y);resource.Set("tileOrigin",std::move(origin));}
    resource.Set("bitmapGlyphs",static_cast<int>(encoded.bitmap_glyphs));
    resource.Set("requiresIsolation",encoded.requires_isolation);
    resource.Set("assetRangeVersion",1);resource.Set("assetRangesComplete",encoded.asset_ranges_complete);
    base::ListValue assets;for(const auto& range:encoded.asset_ranges){base::DictValue asset;asset.Set("offset",static_cast<int>(range.offset));asset.Set("bytes",static_cast<int>(range.bytes));asset.Set("kind",range.kind);if(range.kind=="font")asset.Set("glyphSlots",static_cast<int>(range.glyph_slots));assets.Append(std::move(asset));}resource.Set("assetRanges",std::move(assets));
    resource.Set("quadScale",encoded.quad_scale);
    resource.Set("resourceId",encoded.resource_id);
    if(encoded.reused)cached_layers++;
    if(!NativeResourceIPC()&&(!encoded.reused||snapshot.force_resources))resource.Set("skp",std::move(encoded.skp));
    resource.Set("width",encoded.width);
    resource.Set("height",encoded.height);
    threads.insert(encoded.thread);
    resources.Append(std::move(resource));
  }
  result.Set("resources",std::move(resources));
  base::DictValue timing;
  timing.Set("canvasCopies",snapshot.canvas_copies);timing.Set("canvasMappedCopies",snapshot.canvas_mapped_copies);timing.Set("canvasGpuReadbacks",snapshot.canvas_gpu_readbacks);
  const auto canvas_pool=GetCanvasPixelPool().stats();base::DictValue canvas_stats;
  canvas_stats.Set("bytes",static_cast<double>(canvas_pool.bytes));canvas_stats.Set("peak",static_cast<double>(canvas_pool.peak));canvas_stats.Set("limit",static_cast<double>(canvas_pool.limit));canvas_stats.Set("owners",static_cast<int>(canvas_pool.owners));canvas_stats.Set("denied",static_cast<double>(canvas_pool.denied));timing.Set("canvasPixelPool",std::move(canvas_stats));
  timing.Set("recordingMs",snapshot.recording_ms);timing.Set("portableMs",portable_ms);
  timing.Set("recordingCacheHits",snapshot.recording_cache_hits);
  timing.Set("recordingCacheMisses",snapshot.recording_cache_misses);
  timing.Set("recordingEncodingMisses",snapshot.recording_encoding_misses);
  timing.Set("recordingIndexEnabled",snapshot.recording_index_enabled);timing.Set("recordingIndexEntries",snapshot.recording_index_entries);
  const auto index=GetRecordingIndexPool().stats();base::DictValue index_stats;
  index_stats.Set("bytes",static_cast<double>(index.bytes));index_stats.Set("peak",static_cast<double>(index.peak));index_stats.Set("limit",static_cast<double>(index.limit));index_stats.Set("caches",static_cast<int>(index.caches));index_stats.Set("denied",static_cast<double>(index.denied));index_stats.Set("scope","renderer-process-scalar-recording-index");index_stats.Set("cacheCharge",static_cast<int>(kRecordingIndexCharge));timing.Set("recordingIndexPool",std::move(index_stats));
  timing.Set("glyphCollectionMs",glyph_collection_ms);timing.Set("serializeMs",serialize_ms);
  timing.Set("fontMs",font_ms);timing.Set("imageMs",image_ms);timing.Set("base64Ms",base64_ms);
  timing.Set("parallelLayers",static_cast<int>(layers.size()));
  timing.Set("encodingThreads",static_cast<int>(threads.size()));
  timing.Set("cachedLayers",cached_layers);
  timing.Set("fontCacheHits",static_cast<int>(font_cache_hits));timing.Set("imageCacheHits",static_cast<int>(image_cache_hits));
  timing.Set("fontEncodingShares",static_cast<int>(font_encoding_shares));timing.Set("imageEncodingShares",static_cast<int>(image_encoding_shares));
  const auto asset_cache = GetSerializerAssetCacheStats();
  base::DictValue cache_stats;
  cache_stats.Set("fontBytes",static_cast<double>(asset_cache.font_bytes));
  cache_stats.Set("imageBytes",static_cast<double>(asset_cache.image_bytes));
  cache_stats.Set("fontEntries",static_cast<int>(asset_cache.font_entries));
  cache_stats.Set("imageEntries",static_cast<int>(asset_cache.image_entries));
  cache_stats.Set("fontEvictions",static_cast<double>(asset_cache.font_evictions));
  cache_stats.Set("imageEvictions",static_cast<double>(asset_cache.image_evictions));
  cache_stats.Set("fontPending",static_cast<int>(asset_cache.font_pending));
  cache_stats.Set("imagePending",static_cast<int>(asset_cache.image_pending));
  cache_stats.Set("fontEncodes",static_cast<double>(asset_cache.font_encodes));
  cache_stats.Set("imageEncodes",static_cast<double>(asset_cache.image_encodes));
  cache_stats.Set("fontShares",static_cast<double>(asset_cache.font_shares));
  cache_stats.Set("imageShares",static_cast<double>(asset_cache.image_shares));
  cache_stats.Set("fontBypasses",static_cast<double>(asset_cache.font_bypasses));
  cache_stats.Set("imageBypasses",static_cast<double>(asset_cache.image_bypasses));
  timing.Set("assetCache",std::move(cache_stats));
  base::DictValue host_stats;
  {auto& state=GetState();base::AutoLock lock(state.lock);
    const auto hosts=state.hosts.stats();
    host_stats.Set("hosts",static_cast<int>(hosts.hosts));
    host_stats.Set("encodings",static_cast<int>(hosts.encodings));
    host_stats.Set("ownersAlive",static_cast<int>(hosts.owners_alive));
    host_stats.Set("created",static_cast<double>(hosts.created));
    host_stats.Set("released",static_cast<double>(hosts.released));
    host_stats.Set("damageEntries",static_cast<int>(state.damages.size()));
    host_stats.Set("markerHosts",static_cast<int>(state.frame_markers.size()));
    host_stats.Set("scope","renderer-process");
    host_stats.Set("cacheBytes",static_cast<double>(hosts.cached_bytes));
    host_stats.Set("residentBytes",static_cast<double>(hosts.resident_bytes));
    host_stats.Set("retiredPinBytes",static_cast<double>(hosts.retired_pin_bytes));
    host_stats.Set("cachedPinBytes",static_cast<double>(hosts.cached_pin_bytes));
    host_stats.Set("peakResidentBytes",static_cast<double>(hosts.peak_resident_bytes));
    host_stats.Set("byteLimit",static_cast<double>(hosts.byte_limit));
    host_stats.Set("entryLimit",static_cast<int>(hosts.entry_limit));
    host_stats.Set("evictions",static_cast<double>(hosts.evictions));
    host_stats.Set("admissions",static_cast<double>(hosts.admissions));
    host_stats.Set("admissionBypasses",static_cast<double>(hosts.rejections));
    host_stats.Set("pinnedPressureBypasses",static_cast<double>(hosts.pinned_rejections));
    host_stats.Set("oversizedBypasses",static_cast<double>(hosts.oversized_rejections));
    host_stats.Set("sharedInputBypasses",static_cast<double>(hosts.shared_rejections));
    host_stats.Set("staleOwnerBypasses",static_cast<double>(hosts.stale_rejections));
    host_stats.Set("hostIndexEstimateBytes",static_cast<double>(hosts.host_index_estimate_bytes));
  }
  timing.Set("captureHosts",std::move(host_stats));
  timing.Set("resultAssemblyMs",(base::TimeTicks::Now() - started).InMillisecondsF());
  timing.Set("encodeTotalMs",base::TimeTicks::Now().since_origin().InMillisecondsF()-snapshot.encoding_started_ms);
  result.Set("timing",std::move(timing));
  return result;
}
base::DictValue SubscriptionMetadata(const SubscriptionState::Ticket& ticket) {
  base::DictValue out;out.Set("version",1);out.Set("id",std::string(ticket.key.view()));
  out.Set("generation",static_cast<double>(ticket.generation));
  out.Set("captureOrdinal",static_cast<double>(ticket.ordinal));
  out.Set("pageEpoch",static_cast<double>(ticket.context.page_epoch));
  out.Set("viewportVersion",static_cast<double>(ticket.context.viewport_version));
  out.Set("inputSeq",static_cast<double>(ticket.context.input_seq));
  out.Set("cssWidth",static_cast<int>(ticket.context.css_width));
  out.Set("cssHeight",static_cast<int>(ticket.context.css_height));return out;
}
SubscriptionState::Outcome SendResults(const Snapshot& snapshot,base::DictValue& result,
    const std::vector<EncodedLayer>& layers,const std::optional<SubscriptionState::Ticket>& ticket) {
  result.Set("nativeResources",true);
  if(ticket) {
    result.Set("subscription",SubscriptionMetadata(*ticket));
    auto* timing=result.EnsureDict("timing");
    timing->Set("captureStartedMicros",static_cast<double>(ticket->capture_started_us));
    timing->Set("captureClock","chromium-time-ticks-v1");
  }
  std::string metadata;
  if(!base::JSONWriter::Write(result,&metadata)) {
    result.Set("error","Native metadata encoding failed");return SubscriptionState::Outcome::Pause;
  }
  BinaryWriter wire;wire.Bytes("RPA2");wire.U8(1);wire.U8(1);wire.String(snapshot.capture_id);wire.String(metadata);
  const bool valid=!result.contains("error");
  uint32_t count=0;
  for(const auto& layer:layers)if(valid&&layer.payload&&(!layer.reused||snapshot.force_resources))count++;
  wire.U32(count);
  for(const auto& layer:layers)if(valid&&layer.payload&&(!layer.reused||snapshot.force_resources)) {
    wire.String(layer.resource_id);wire.U32(layer.payload->size());
    wire.Bytes(std::string_view(static_cast<const char*>(layer.payload->data()),layer.payload->size()));
  }
  static base::NoDestructor<VizSocket> socket(base::Environment::Create()->GetVar("REMOTE_PAINT_SOCKET").value_or(""));
  if(ticket)return socket->SendWithCredit(wire.bytes,*ticket).value_or(SubscriptionState::Outcome::Pause);
  if(!socket->Send(wire.bytes))result.Set("error","Native resource IPC failed");
  result.Set("resources",base::ListValue());
  return SubscriptionState::Outcome::Consumed;
}
void CompleteCapture(Snapshot snapshot,std::unique_ptr<CaptureRequest> request,
                     std::vector<EncodedLayer> layers) {
  auto result=BuildResults(snapshot,layers);
  if(request->subscription) {
    const auto ticket=*request->subscription;
    bool publish;
    {auto& state=GetState();base::AutoLock lock(state.lock);publish=state.subscriptions.BeginPublish(ticket);}
    const auto outcome=publish?SendResults(snapshot,result,layers,ticket):SubscriptionState::Outcome::Pause;
    // Actual picture/encoded owners outlive the definitive credit. No V8 or
    // per-frame callback crosses back to the renderer's script thread.
    layers.clear();request.reset();
    FinishSubscription(ticket,outcome);return;
  }
  if(NativeResourceIPC()&&!result.contains("error"))SendResults(snapshot,result,layers,std::nullopt);
  FinishLegacy(*request);
  std::move(request->reply).Run(std::move(result));

}
}
SubscriptionState::BindResult BindCaptureSubscription(int host,uintptr_t document,int world,
    const SubscriptionState::Key& key,const SubscriptionState::Context& context,
    uint64_t minimum_base,int minimum_source_frame,base::RepeatingClosure wake) {
  if(!NativeResourceIPC()||!document||world<=0||!wake)
    return {SubscriptionState::BindStatus::Invalid,std::nullopt};
  auto& state=GetState();base::AutoLock lock(state.lock);
  auto* existing=FindBinding(state,host,key);
  if(existing&&(existing->document!=document||existing->world!=world))
    return {SubscriptionState::BindStatus::Busy,std::nullopt};
  if(state.legacy_jobs.contains(host))return {SubscriptionState::BindStatus::Busy,std::nullopt};
  if(!existing&&state.legacy_jobs.size()+state.subscriptions.stats().bindings>=SubscriptionState::kSlots)
    return {SubscriptionState::BindStatus::Full,std::nullopt};
  auto result=state.subscriptions.Bind(host,key,context,minimum_base,minimum_source_frame);
  if(result.status==SubscriptionState::BindStatus::Bound) {
    auto free=std::find_if(state.bindings.begin(),state.bindings.end(),[](const auto& b){return !b.document;});
    CHECK(free!=state.bindings.end());
    *free=SubscriptionBinding{document,world,host,key,std::move(wake)};
  }
  RefreshSubscriptions(state);return result;
}
std::optional<SubscriptionState::Snapshot> InspectCaptureSubscription(int host,const SubscriptionState::Key& key) {
  auto& state=GetState();base::AutoLock lock(state.lock);return state.subscriptions.Inspect(host,key);
}
bool UpdateCaptureSubscription(int host,const SubscriptionState::Key& key,
    uint64_t input_seq,bool full_resources,bool request_frame,int minimum_source_frame) {
  base::RepeatingClosure wake,arm;
  {auto& state=GetState();base::AutoLock lock(state.lock);
    auto* binding=FindBinding(state,host,key);
    if(!binding||!state.subscriptions.Update(host,key,input_seq,full_resources,request_frame,minimum_source_frame,ScheduleNow()))return false;
    const auto current=state.subscriptions.Inspect(host,key);
    if(request_frame&&current->enabled)wake=binding->wake;
    arm=RequestScheduleArmLocked(state);
  }
  if(wake)wake.Run();if(arm)arm.Run();return true;
}
bool EnableCaptureSubscription(int host,const SubscriptionState::Key& key,bool enabled,int minimum_source_frame) {
  base::RepeatingClosure wake,arm;
  {auto& state=GetState();base::AutoLock lock(state.lock);
    auto* binding=FindBinding(state,host,key);
    if(!binding||!state.subscriptions.SetEnabled(host,key,enabled,minimum_source_frame,ScheduleNow()))return false;
    RefreshSubscriptions(state);
    if(enabled)wake=binding->wake;
    arm=RequestScheduleArmLocked(state);
  }
  if(wake)wake.Run();if(arm)arm.Run();return true;
}
bool SetCaptureCadence(int host,const SubscriptionState::Key& key,uint64_t interval_us,uint64_t heartbeat_us){
  base::RepeatingClosure arm;
  {auto& state=GetState();base::AutoLock lock(state.lock);
    if(!FindBinding(state,host,key)||!state.subscriptions.SetCadence(host,key,interval_us,heartbeat_us,ScheduleNow()))return false;
    // This API is called only on the renderer's main/script sequence.
    if(!state.schedule_arm)state.schedule_arm=base::BindPostTaskToCurrentDefault(base::BindRepeating(&ArmNativeSchedule));
    arm=RequestScheduleArmLocked(state);
  }
  if(arm)arm.Run();return true;
}
base::DictValue CaptureSchedulerStats(){
  auto& state=GetState();base::AutoLock lock(state.lock);base::DictValue out;out.Set("ok",true);
  // A bounded private probe lets observers calibrate this clock rather than
  // subtracting renderer, Node and Viewer clock origins directly.
  out.Set("clock","chromium-time-ticks-v1");
  out.Set("nowMicros",static_cast<double>(ScheduleNow()));
  out.Set("rendererProcessId",static_cast<int>(base::GetCurrentProcId()));
  out.Set("armed",state.timer_running);out.Set("armPosted",state.schedule_arm_posted);
  out.Set("dueMicros",static_cast<double>(state.timer_due_us));
  out.Set("ticks",static_cast<double>(state.timer_ticks));out.Set("arms",static_cast<double>(state.timer_arms));out.Set("wakes",static_cast<double>(state.timer_wakes));
  return out;
}
bool CancelCaptureSubscription(int host,const SubscriptionState::Key& key) {
  base::RepeatingClosure arm;
  {auto& state=GetState();base::AutoLock lock(state.lock);
    if(!state.subscriptions.Cancel(host,key))return false;
    if(auto* binding=FindBinding(state,host,key)) *binding=SubscriptionBinding{};
    RefreshSubscriptions(state);arm=RequestScheduleArmLocked(state);
  }
  if(arm)arm.Run();return true;
}
void InvalidateCaptureDocument(uintptr_t document,std::optional<int> world) {
  std::array<CaptureHostRegistry<EncodedPicture>::Retired,SubscriptionState::kSlots> retired;
  auto& state=GetState();
  base::RepeatingClosure arm;
  {base::AutoLock lock(state.lock);size_t count=0;
    for(auto& binding:state.bindings)if(binding.document==document&&(!world||binding.world==*world)) {
      const int host=binding.host;
      state.subscriptions.Cancel(host,binding.key);binding=SubscriptionBinding{};
      retired[count++]=state.hosts.Release(host);
      state.frame_markers.Forget(host);
      std::erase_if(state.damages,[host](const auto& entry){return entry.first.first==host;});
    }
    state.has_frame_markers.store(state.frame_markers.size()>0,std::memory_order_relaxed);
    RefreshSubscriptions(state);
    arm=RequestScheduleArmLocked(state);
  }
  if(arm)arm.Run();
}
bool RequestCapture(int host,std::string id,base::OnceCallback<void(base::DictValue)> reply,bool force_resources){
  auto& state=GetState();
  {base::AutoLock lock(state.lock);
    if(state.legacy_jobs.contains(host)||state.subscriptions.HasHost(host)||
       state.legacy_jobs.size()+state.subscriptions.stats().bindings>=SubscriptionState::kSlots)return false;
    state.legacy_jobs.emplace(host,id);
    auto request=std::make_unique<CaptureRequest>(host,id,std::move(reply),force_resources);
    request->owner=state.hosts.Acquire(host);
    state.requests.emplace(host,std::move(request));
    state.pending.fetch_add(1,std::memory_order_relaxed);
  }
  base::ThreadPool::PostDelayedTask(FROM_HERE,{},base::BindOnce([](int host,std::string id){
    std::unique_ptr<CaptureRequest> expired;auto& state=GetState();
    {base::AutoLock lock(state.lock);auto it=state.requests.find(host);
      if(it==state.requests.end()||it->second->capture_id!=id)return;
      expired=std::move(it->second);state.requests.erase(it);state.pending.fetch_sub(1,std::memory_order_relaxed);
    }
    FinishLegacy(*expired);
    base::DictValue error;error.Set("error","No compositor frame before capture deadline");
    std::move(expired->reply).Run(std::move(error));
  },host,std::move(id)),base::Seconds(5));
  return true;
}
std::unique_ptr<CaptureRequest> TakeCapture(int host,int source_frame,bool damaged){
  auto& state=GetState();
  if(!state.pending.load(std::memory_order_relaxed)&&!state.subscriptions_enabled.load(std::memory_order_relaxed))return nullptr;
  base::RepeatingClosure arm;std::unique_ptr<CaptureRequest> request;
  {base::AutoLock lock(state.lock);auto it=state.requests.find(host);
    if(it!=state.requests.end()) {
      auto result=std::move(it->second);state.requests.erase(it);state.pending.fetch_sub(1,std::memory_order_relaxed);return result;
    }
    const auto taken=state.subscriptions.Take(host,source_frame,damaged,ScheduleNow());
    if(taken.schedule_changed)arm=RequestScheduleArmLocked(state);
    if(taken.ticket){
      const auto& ticket=*taken.ticket;
      request=std::make_unique<CaptureRequest>(host,std::string(ticket.key.view())+":"+base::NumberToString(ticket.ordinal),
          base::OnceCallback<void(base::DictValue)>(),ticket.full_resources);
      request->subscription=ticket;request->owner=state.hosts.Acquire(host);
    }
    RefreshSubscriptions(state);
  }
  if(arm)arm.Run();return request;
}
void ReleaseCaptureHost(int host){
  std::unique_ptr<CaptureRequest> canceled;
  CaptureHostRegistry<EncodedPicture>::Retired retired;
  bool was_owned=false;
  base::RepeatingClosure arm;
  {auto& state=GetState();base::AutoLock lock(state.lock);
    was_owned=state.hosts.Contains(host);
    state.subscriptions.RetireHost(host);
    for(auto& binding:state.bindings)if(binding.host==host)binding=SubscriptionBinding{};
    RefreshSubscriptions(state);
    arm=RequestScheduleArmLocked(state);
    auto found=state.requests.find(host);
    if(found!=state.requests.end()){
      canceled=std::move(found->second);state.requests.erase(found);
      state.pending.fetch_sub(1,std::memory_order_relaxed);
    }
    retired=state.hosts.Release(host);
    std::erase_if(state.damages,[host](const auto& entry){return entry.first.first==host;});
    state.frame_markers.Forget(host);
    state.has_frame_markers.store(state.frame_markers.size()>0,std::memory_order_relaxed);
  }
  if(arm)arm.Run();
  if(canceled){
    FinishLegacy(*canceled);
    base::DictValue error;error.Set("error","Capture host was destroyed");
    error.Set("code","NATIVE_CAPTURE_HOST_CLOSED");
    std::move(canceled->reply).Run(std::move(error));
  }
  static const bool trace=base::Environment::Create()->GetVar("REMOTE_PAINT_TRACE").value_or("")=="1";
  if(trace&&was_owned)LOG(ERROR)<<"REMOTE_PAINT_CAPTURE_HOST_RELEASE pid="<<base::GetCurrentProcId()<<" host="<<host<<" encodings="<<retired.size()<<" canceled="<<!!canceled;
}
std::string RememberCaptureFrameMarker(int host,const std::string& id,uint32_t token){
  auto& state=GetState();base::AutoLock lock(state.lock);
  auto marker=state.frame_markers.Remember(host,id,token);
  state.has_frame_markers.store(state.frame_markers.size()>0,std::memory_order_relaxed);
  return marker;
}
std::string LastCaptureFrameMarker(int host){
  auto& state=GetState();if(!state.has_frame_markers.load(std::memory_order_relaxed))return {};
  base::AutoLock lock(state.lock);return state.frame_markers.Last(host);
}
bool IsTiledCaptureEnabled(){
  static const bool enabled=base::Environment::Create()->GetVar("REMOTE_PAINT_TILED_CAPTURE").value_or("")=="1";
  return enabled;
}
void TrackLayerDamage(int host,int layer,int x,int y,int width,int height){
  if(!IsTiledCaptureEnabled()||width<=0||height<=0)return;
  auto& state=GetState();base::AutoLock lock(state.lock);
  // Before the first capture every tile is recorded in full. Unobserved and
  // destroyed hosts must not create process-wide damage ownership.
  if(!state.hosts.Contains(host))return;
  if(state.damages.size()>4096)state.damages.clear();
  auto [it,inserted]=state.damages.try_emplace({host,layer},std::array<int,4>{x,y,x+width,y+height});
  if(!inserted){auto& r=it->second;r[0]=std::min(r[0],x);r[1]=std::min(r[1],y);r[2]=std::max(r[2],x+width);r[3]=std::max(r[3],y+height);}
}
std::optional<std::array<int,4>> TakeLayerDamage(int host,int layer){
  auto& state=GetState();base::AutoLock lock(state.lock);auto it=state.damages.find({host,layer});if(it==state.damages.end())return std::nullopt;auto result=it->second;state.damages.erase(it);return result;
}
uint64_t NewRecordingKey(){
  auto key=NextRecordingKey().fetch_add(1,std::memory_order_relaxed);
  return key?key:NextRecordingKey().fetch_add(1,std::memory_order_relaxed);
}
void EncodeAndReply(Snapshot snapshot,std::unique_ptr<CaptureRequest> request){
  if(!snapshot.error.empty())snapshot.records.clear();
  snapshot.force_resources=request->force_resources;
  snapshot.encoding_started_ms=base::TimeTicks::Now().since_origin().InMillisecondsF();
  if(snapshot.records.empty()){
    base::ThreadPool::PostTask(FROM_HERE,{base::MayBlock(),base::TaskPriority::USER_VISIBLE},
      base::BindOnce([](Snapshot snapshot,std::unique_ptr<CaptureRequest> request){
        CompleteCapture(std::move(snapshot),std::move(request),{});
      },std::move(snapshot),std::move(request)));
    return;
  }
  auto records=std::move(snapshot.records);
  const auto owner=request->owner;
  auto done = base::BarrierCallback<EncodedLayer>(records.size(),
      base::BindOnce([](Snapshot snapshot,std::unique_ptr<CaptureRequest> request,
                        std::vector<EncodedLayer> layers){
        CompleteCapture(std::move(snapshot),std::move(request),std::move(layers));
      },std::move(snapshot),std::move(request)));
  for(size_t index=0;index<records.size();index++){
    auto callback=done;
    auto task=base::BindOnce([](CaptureOwner owner,size_t index,LayerRecord record,
                                base::RepeatingCallback<void(EncodedLayer)> done){
      done.Run(EncodeLayer(std::move(owner),index,std::move(record)));
    },owner,index,std::move(records[index]),std::move(callback));
    if(!base::ThreadPool::PostTask(FROM_HERE,
          {base::MayBlock(),base::TaskPriority::USER_VISIBLE},std::move(task))){
      EncodedLayer failed;failed.index=index;failed.error="Encoding task rejected";done.Run(std::move(failed));
    }
  }
}

std::shared_ptr<const EncodedPicture> LookupCachedEncoding(const CaptureOwner& owner,
                                                            uint64_t key) {
  return GetState().hosts.Lookup(owner,key);
}

std::shared_ptr<const EncodedPicture> StoreCachedEncoding(const CaptureOwner& owner, uint64_t key,
                         std::shared_ptr<const EncodedPicture> encoded) {
  const auto charge=EncodedPictureRetainedBytes(*encoded);
  return GetState().hosts.Store(owner,key,std::move(encoded),charge).value;
}
}
