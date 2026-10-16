#include "components/remote_paint/capture_state.h"
#include <algorithm>
#include <atomic>
#include <map>
#include <set>
#include <utility>
#include "base/base64.h"
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
namespace remote_paint {
namespace {
struct State {
  base::Lock lock;
  std::atomic<int> pending{0};
  std::map<int,std::unique_ptr<CaptureRequest>> requests;
};
State& GetState(){static base::NoDestructor<State> state;return *state;}
struct EncodedLayer {
  size_t index = 0;
  int local_id = 0;
  float quad_scale = 0;
  int width = 0;
  int height = 0;
  size_t bitmap_glyphs = 0;
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
};

EncodedLayer EncodeLayer(size_t index, LayerRecord record) {
  EncodedLayer result;
  result.index = index;
  result.local_id = record.local_id;
  result.quad_scale = record.quad_scale;
  result.width = record.picture->cullRect().width();
  result.height = record.picture->cullRect().height();
  result.thread = base::NumberToString(base::PlatformThread::CurrentId().raw());
  auto encoded=SerializePicture(*record.picture);
  result.portable_ms = encoded.portable_ms;
  result.glyph_collection_ms = encoded.glyph_collection_ms;
  result.serialize_ms = encoded.serialize_ms;
  result.font_ms = encoded.font_ms;
  result.image_ms = encoded.image_ms;
  result.bitmap_glyphs = encoded.bitmap_glyphs;
  if(!encoded.bytes){
    result.error = encoded.error.empty() ? "Picture encoding failed" : encoded.error;
    return result;
  }
  const auto base64_started = base::TimeTicks::Now();
  result.skp = base::Base64Encode(UNSAFE_BUFFERS(
      base::span(encoded.bytes->bytes(), encoded.bytes->size())));
  result.base64_ms = (base::TimeTicks::Now() - base64_started).InMillisecondsF();
  result.byte_size = encoded.bytes->size();
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
  base::ListValue resources;size_t total=0;std::set<std::string> threads;
  for(auto& encoded:layers){
    portable_ms += encoded.portable_ms;glyph_collection_ms += encoded.glyph_collection_ms;
    serialize_ms += encoded.serialize_ms;font_ms += encoded.font_ms;image_ms += encoded.image_ms;
    base64_ms += encoded.base64_ms;
    if(!encoded.error.empty()){
      result.Set("error",encoded.error);return result;
    }
    if((total+=encoded.byte_size)>64*1024*1024){
      result.Set("error","Frame byte budget exceeded");return result;
    }
    base::DictValue resource;
    resource.Set("localId",encoded.local_id);
    resource.Set("bitmapGlyphs",static_cast<int>(encoded.bitmap_glyphs));
    resource.Set("quadScale",encoded.quad_scale);
    resource.Set("skp",std::move(encoded.skp));
    resource.Set("width",encoded.width);
    resource.Set("height",encoded.height);
    threads.insert(encoded.thread);
    resources.Append(std::move(resource));
  }
  result.Set("resources",std::move(resources));
  base::DictValue timing;
  timing.Set("recordingMs",snapshot.recording_ms);timing.Set("portableMs",portable_ms);
  timing.Set("glyphCollectionMs",glyph_collection_ms);timing.Set("serializeMs",serialize_ms);
  timing.Set("fontMs",font_ms);timing.Set("imageMs",image_ms);timing.Set("base64Ms",base64_ms);
  timing.Set("parallelLayers",static_cast<int>(layers.size()));
  timing.Set("encodingThreads",static_cast<int>(threads.size()));
  timing.Set("encodeTotalMs",(base::TimeTicks::Now() - started).InMillisecondsF());
  result.Set("timing",std::move(timing));
  return result;
}
}
bool RequestCapture(int host,std::string id,base::OnceCallback<void(base::DictValue)> reply){
  auto& state=GetState();
  {base::AutoLock lock(state.lock);
    if(state.requests.size()>=4||state.requests.contains(host))return false;
    state.requests.emplace(host,std::make_unique<CaptureRequest>(id,std::move(reply)));
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
void EncodeAndReply(Snapshot snapshot,std::unique_ptr<CaptureRequest> request){
  if(snapshot.records.empty()){
    base::ThreadPool::PostTask(FROM_HERE,{base::MayBlock(),base::TaskPriority::USER_VISIBLE},
      base::BindOnce([](Snapshot snapshot,std::unique_ptr<CaptureRequest> request){
        std::move(request->reply).Run(EncodeResults(std::move(snapshot),{}));
      },std::move(snapshot),std::move(request)));
    return;
  }
  auto records=std::move(snapshot.records);
  auto done = base::BarrierCallback<EncodedLayer>(records.size(),
      base::BindOnce([](Snapshot snapshot,std::unique_ptr<CaptureRequest> request,
                        std::vector<EncodedLayer> layers){
        auto result=EncodeResults(std::move(snapshot),std::move(layers));
        std::move(request->reply).Run(std::move(result));
      },std::move(snapshot),std::move(request)));
  for(size_t index=0;index<records.size();index++){
    auto callback=done;
    auto task=base::BindOnce([](size_t index,LayerRecord record,
                                base::RepeatingCallback<void(EncodedLayer)> done){
      done.Run(EncodeLayer(index,std::move(record)));
    },index,std::move(records[index]),std::move(callback));
    if(!base::ThreadPool::PostTask(FROM_HERE,
          {base::MayBlock(),base::TaskPriority::USER_VISIBLE},std::move(task))){
      EncodedLayer failed;failed.index=index;failed.error="Encoding task rejected";done.Run(std::move(failed));
    }
  }
}
}
