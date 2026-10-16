#include "components/remote_paint/capture_state.h"
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
#include "base/strings/string_number_conversions.h"
#include "base/synchronization/lock.h"
#include "base/task/thread_pool.h"
#include "base/threading/platform_thread.h"
#include "base/time/time.h"
#include "components/remote_paint/serializer.h"
#include "components/remote_paint/socket_transport.h"
#include "base/json/json_writer.h"
#include "crypto/sha2.h"
namespace remote_paint {
namespace {
struct State {
  base::Lock lock;
  std::atomic<int> pending{0};
  std::map<std::pair<int,int>,std::array<int,4>> damages;
  std::map<int,std::unique_ptr<CaptureRequest>> requests;
  std::map<int,std::map<uint64_t,std::shared_ptr<const EncodedPicture>>> encodings;
};
State& GetState(){static base::NoDestructor<State> state;return *state;}
std::atomic<uint64_t>& NextRecordingKey(){static std::atomic<uint64_t> next{1};return next;}
bool NativeResourceIPC(){
  static const bool enabled=base::Environment::Create()->GetVar("REMOTE_PAINT_NATIVE_RESOURCES").value_or("")=="1";return enabled;
}
struct EncodedLayer {
  sk_sp<const SkData> payload;
  size_t index = 0;
  int local_id = 0;
  float quad_scale = 0;
  int width = 0;
  int height = 0;
  size_t bitmap_glyphs = 0;
  bool requires_isolation = false;
  size_t font_cache_hits=0,image_cache_hits=0;
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
  bool reused = false;
  std::string resource_id;
};

EncodedLayer EncodeLayer(int host, size_t index, LayerRecord record) {
  EncodedLayer result;
  result.index = index;
  result.tiled = record.tiled;result.tile_x=record.tile_x;result.tile_y=record.tile_y;
  result.local_id = record.local_id;
  result.quad_scale = record.quad_scale;
  result.width = record.picture->cullRect().width();
  result.height = record.picture->cullRect().height();
  result.thread = base::NumberToString(base::PlatformThread::CurrentId().raw());
  std::shared_ptr<const EncodedPicture> encoded=record.encoded;
  if(!encoded){
    auto serialized=SerializePicture(*record.picture);
    result.portable_ms = serialized.portable_ms;
    result.glyph_collection_ms = serialized.glyph_collection_ms;
    result.serialize_ms = serialized.serialize_ms;
    result.font_ms = serialized.font_ms;
    result.image_ms = serialized.image_ms;
    result.font_cache_hits=serialized.font_cache_hits;result.image_cache_hits=serialized.image_cache_hits;
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
    encoded=mutable_encoded;
    StoreCachedEncoding(host,record.recording_key,encoded);
  } else {
    result.byte_size = encoded->serialized.bytes->size();
    result.reused = true;
  }
  result.bitmap_glyphs = encoded->serialized.bitmap_glyphs;
  result.requires_isolation = encoded->serialized.requires_isolation;
  if(!result.reused){
    result.portable_ms = encoded->serialized.portable_ms;
    result.glyph_collection_ms = encoded->serialized.glyph_collection_ms;
    result.serialize_ms = encoded->serialized.serialize_ms;
    result.font_ms = encoded->serialized.font_ms;
    result.image_ms = encoded->serialized.image_ms;
  }
  if(NativeResourceIPC()&&!result.reused)result.payload=encoded->serialized.bytes;
  result.skp = encoded->base64;
  result.asset_ranges=encoded->serialized.asset_ranges;
  result.resource_id = encoded->resource_id;
  return result;
}

base::DictValue EncodeResults(Snapshot snapshot,
                              std::vector<EncodedLayer> layers) {
  std::sort(layers.begin(),layers.end(),[](const auto& a,const auto& b){return a.index<b.index;});
  const auto started = base::TimeTicks::Now();
  double portable_ms = 0, glyph_collection_ms = 0, serialize_ms = 0, font_ms = 0, image_ms = 0, base64_ms = 0;
  base::DictValue result;
  result.Set("captureId",snapshot.capture_id);
  result.Set("producer",snapshot.producer);
  result.Set("frameToken",static_cast<double>(snapshot.frame_token));
  result.Set("sourceFrame",snapshot.source_frame);
  result.Set("recordingThread",snapshot.recording_thread);
  result.Set("encodingThread",base::NumberToString(base::PlatformThread::CurrentId().raw()));
  if(!snapshot.error.empty()){result.Set("error",snapshot.error);return result;}
  base::ListValue resources;size_t total=0,font_cache_hits=0,image_cache_hits=0;std::set<std::string> threads;int cached_layers=0;
  for(auto& encoded:layers){
    portable_ms += encoded.portable_ms;glyph_collection_ms += encoded.glyph_collection_ms;
    serialize_ms += encoded.serialize_ms;font_ms += encoded.font_ms;image_ms += encoded.image_ms;
    base64_ms += encoded.base64_ms;
    font_cache_hits+=encoded.font_cache_hits;image_cache_hits+=encoded.image_cache_hits;
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
    base::ListValue assets;for(const auto& range:encoded.asset_ranges){base::DictValue asset;asset.Set("offset",static_cast<int>(range.offset));asset.Set("bytes",static_cast<int>(range.bytes));asset.Set("kind",range.kind);assets.Append(std::move(asset));}resource.Set("assetRanges",std::move(assets));
    resource.Set("quadScale",encoded.quad_scale);
    resource.Set("resourceId",encoded.resource_id);
    if(encoded.reused){cached_layers++;}else if(!NativeResourceIPC())resource.Set("skp",std::move(encoded.skp));
    resource.Set("width",encoded.width);
    resource.Set("height",encoded.height);
    threads.insert(encoded.thread);
    resources.Append(std::move(resource));
  }
  result.Set("resources",std::move(resources));
  base::DictValue timing;
  timing.Set("recordingMs",snapshot.recording_ms);timing.Set("portableMs",portable_ms);
  timing.Set("recordingCacheHits",snapshot.recording_cache_hits);
  timing.Set("recordingCacheMisses",snapshot.recording_cache_misses);
  timing.Set("glyphCollectionMs",glyph_collection_ms);timing.Set("serializeMs",serialize_ms);
  timing.Set("fontMs",font_ms);timing.Set("imageMs",image_ms);timing.Set("base64Ms",base64_ms);
  timing.Set("parallelLayers",static_cast<int>(layers.size()));
  timing.Set("encodingThreads",static_cast<int>(threads.size()));
  timing.Set("cachedLayers",cached_layers);
  timing.Set("fontCacheHits",static_cast<int>(font_cache_hits));timing.Set("imageCacheHits",static_cast<int>(image_cache_hits));
  timing.Set("encodeTotalMs",(base::TimeTicks::Now() - started).InMillisecondsF());
  result.Set("timing",std::move(timing));
  if(NativeResourceIPC()){
    result.Set("nativeResources",true);
    std::string metadata;if(!base::JSONWriter::Write(result,&metadata)){result.Set("error","Native metadata encoding failed");return result;}
    BinaryWriter wire;wire.Bytes("RPA2");wire.U8(1);wire.U8(1);wire.String(snapshot.capture_id);wire.String(metadata);
    uint32_t count=0;for(const auto& layer:layers)if(layer.payload)count++;wire.U32(count);
    for(const auto& layer:layers)if(layer.payload){wire.String(layer.resource_id);wire.U32(layer.payload->size());wire.Bytes(std::string_view(static_cast<const char*>(layer.payload->data()),layer.payload->size()));}
    static base::NoDestructor<VizSocket> socket(base::Environment::Create()->GetVar("REMOTE_PAINT_SOCKET").value_or(""));
    if(!socket->Send(wire.bytes))result.Set("error","Native resource IPC failed");
    // Only a completion receipt traverses CDP/Node. Metadata and raw SKPs stay
    // in the native data plane, paired with Viz by capture ID.
    result.Set("resources",base::ListValue());
  }
  return result;
}
}
bool RequestCapture(int host,std::string id,base::OnceCallback<void(base::DictValue)> reply){
  auto& state=GetState();
  {base::AutoLock lock(state.lock);
    if(state.requests.size()>=4||state.requests.contains(host))return false;
    state.requests.emplace(host,std::make_unique<CaptureRequest>(host,id,std::move(reply)));
    state.pending.fetch_add(1,std::memory_order_relaxed);
  }
  base::ThreadPool::PostDelayedTask(FROM_HERE,{},base::BindOnce([](int host,std::string id){
    std::unique_ptr<CaptureRequest> expired;auto& state=GetState();
    {base::AutoLock lock(state.lock);auto it=state.requests.find(host);
      if(it==state.requests.end()||it->second->capture_id!=id)return;
      expired=std::move(it->second);state.requests.erase(it);state.pending.fetch_sub(1,std::memory_order_relaxed);
    }
    base::DictValue error;error.Set("error","No compositor frame before capture deadline");
    std::move(expired->reply).Run(std::move(error));
  },host,std::move(id)),base::Seconds(5));
  return true;
}
std::unique_ptr<CaptureRequest> TakeCapture(int host){
  auto& state=GetState();if(!state.pending.load(std::memory_order_relaxed))return nullptr;
  base::AutoLock lock(state.lock);auto it=state.requests.find(host);
  if(it==state.requests.end())return nullptr;
  auto result=std::move(it->second);state.requests.erase(it);state.pending.fetch_sub(1,std::memory_order_relaxed);return result;
}
bool IsTiledCaptureEnabled(){
  static const bool enabled=base::Environment::Create()->GetVar("REMOTE_PAINT_TILED_CAPTURE").value_or("")=="1";
  return enabled;
}
void TrackLayerDamage(int host,int layer,int x,int y,int width,int height){
  if(!IsTiledCaptureEnabled()||width<=0||height<=0)return;
  auto& state=GetState();base::AutoLock lock(state.lock);
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
  if(snapshot.records.empty()){
    base::ThreadPool::PostTask(FROM_HERE,{base::MayBlock(),base::TaskPriority::USER_VISIBLE},
      base::BindOnce([](Snapshot snapshot,std::unique_ptr<CaptureRequest> request){
        std::move(request->reply).Run(EncodeResults(std::move(snapshot),{}));
      },std::move(snapshot),std::move(request)));
    return;
  }
  auto records=std::move(snapshot.records);
  const int host=request->host;
  auto done = base::BarrierCallback<EncodedLayer>(records.size(),
      base::BindOnce([](Snapshot snapshot,std::unique_ptr<CaptureRequest> request,
                        std::vector<EncodedLayer> layers){
        auto result=EncodeResults(std::move(snapshot),std::move(layers));
        std::move(request->reply).Run(std::move(result));
      },std::move(snapshot),std::move(request)));
  for(size_t index=0;index<records.size();index++){
    auto callback=done;
    auto task=base::BindOnce([](int host,size_t index,LayerRecord record,
                                base::RepeatingCallback<void(EncodedLayer)> done){
      done.Run(EncodeLayer(host,index,std::move(record)));
    },host,index,std::move(records[index]),std::move(callback));
    if(!base::ThreadPool::PostTask(FROM_HERE,
          {base::MayBlock(),base::TaskPriority::USER_VISIBLE},std::move(task))){
      EncodedLayer failed;failed.index=index;failed.error="Encoding task rejected";done.Run(std::move(failed));
    }
  }
}

std::shared_ptr<const EncodedPicture> LookupCachedEncoding(int host,
                                                            uint64_t key) {
  auto& state=GetState();base::AutoLock lock(state.lock);
  auto host_it=state.encodings.find(host);if(host_it==state.encodings.end())return nullptr;
  auto it=host_it->second.find(key);return it==host_it->second.end()?nullptr:it->second;
}

void StoreCachedEncoding(int host, uint64_t key,
                         std::shared_ptr<const EncodedPicture> encoded) {
  if(!key||!encoded)return;
  auto& state=GetState();base::AutoLock lock(state.lock);
  auto& cache=state.encodings[host];
  if(cache.size()>=256&&!cache.contains(key))cache.erase(cache.begin());
  cache[key]=std::move(encoded);
}
}
