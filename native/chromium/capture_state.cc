#include "components/remote_paint/capture_state.h"
#include <atomic>
#include <map>
#include <utility>
#include "base/base64.h"
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
base::DictValue Encode(Snapshot snapshot) {
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
  base::ListValue resources;size_t total=0;
  for(auto& record:snapshot.records){
    auto encoded=SerializePicture(*record.picture);
    portable_ms += encoded.portable_ms;glyph_collection_ms += encoded.glyph_collection_ms;
    serialize_ms += encoded.serialize_ms;font_ms += encoded.font_ms;image_ms += encoded.image_ms;
    if(!encoded.bytes||(total+=encoded.bytes->size())>64*1024*1024){
      result.Set("error",encoded.error.empty()?"Frame byte budget exceeded":encoded.error);return result;
    }
    base::DictValue resource;
    resource.Set("localId",record.local_id);
    resource.Set("bitmapGlyphs",static_cast<int>(encoded.bitmap_glyphs));
    resource.Set("quadScale",record.quad_scale);
    // SkData owns exactly size() immutable bytes for the duration of encoding.
    const auto base64_started = base::TimeTicks::Now();
    resource.Set("skp",base::Base64Encode(UNSAFE_BUFFERS(base::span(encoded.bytes->bytes(),encoded.bytes->size()))));
    base64_ms += (base::TimeTicks::Now() - base64_started).InMillisecondsF();
    resource.Set("width",record.picture->cullRect().width());
    resource.Set("height",record.picture->cullRect().height());
    resources.Append(std::move(resource));
  }
  result.Set("resources",std::move(resources));
  base::DictValue timing;
  timing.Set("recordingMs",snapshot.recording_ms);timing.Set("portableMs",portable_ms);
  timing.Set("glyphCollectionMs",glyph_collection_ms);timing.Set("serializeMs",serialize_ms);
  timing.Set("fontMs",font_ms);timing.Set("imageMs",image_ms);timing.Set("base64Ms",base64_ms);
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
  base::ThreadPool::PostTask(FROM_HERE,{base::MayBlock(),base::TaskPriority::USER_VISIBLE},
    base::BindOnce([](Snapshot snapshot,std::unique_ptr<CaptureRequest> request){
      std::move(request->reply).Run(Encode(std::move(snapshot)));
    },std::move(snapshot),std::move(request)));
}
}
