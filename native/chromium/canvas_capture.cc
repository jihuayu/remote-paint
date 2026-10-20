#include "components/remote_paint/canvas_capture.h"
#include <algorithm>
#include <atomic>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string_view>
#if defined(REMOTE_PAINT_CHROMIUM)
#include "base/compiler_specific.h"
#else
#define UNSAFE_BUFFERS(...) __VA_ARGS__
#endif
#include "third_party/skia/include/core/SkCanvas.h"
#include "third_party/skia/include/core/SkPaint.h"
#include "third_party/skia/include/core/SkPictureRecorder.h"
#include "third_party/skia/include/core/SkSamplingOptions.h"
namespace remote_paint {
struct CanvasPixelPool::State {
 explicit State(size_t bytes):limit(bytes){}
 const size_t limit;
 std::atomic<size_t> used{0},peak{0},owners{0},denied{0};
};
CanvasPixelPool::CanvasPixelPool(size_t limit):state_(std::make_shared<State>(limit)){}
CanvasPixelPool::~CanvasPixelPool()=default;
std::shared_ptr<void> CanvasPixelPool::Reserve(size_t bytes,std::string* error){
 struct Lease {Lease(std::shared_ptr<State> owner,size_t cost):state(std::move(owner)),bytes(cost){}std::shared_ptr<State> state;size_t bytes;~Lease(){state->used.fetch_sub(bytes);state->owners.fetch_sub(1);}};
 if(!state_->limit){*error="Invalid REMOTE_PAINT_CANVAS_PIXEL_BYTES";return {};}
 auto used=state_->used.load();
 for(;;){if(bytes>state_->limit||used>state_->limit-bytes){state_->denied.fetch_add(1);*error=kCanvasPixelPressure;return {};}
  if(state_->used.compare_exchange_weak(used,used+bytes))break;}
 auto peak=state_->peak.load();while(peak<used+bytes&&!state_->peak.compare_exchange_weak(peak,used+bytes)){}
 state_->owners.fetch_add(1);return std::make_shared<Lease>(state_,bytes);
}
CanvasPixelPool::Stats CanvasPixelPool::stats()const{return {state_->used.load(),state_->peak.load(),state_->limit,state_->owners.load(),state_->denied.load()};}
CanvasPixelPool& GetCanvasPixelPool(){
 static CanvasPixelPool* const pool=[](){
  size_t bytes=256*1024*1024;
  if(const char* text=std::getenv("REMOTE_PAINT_CANVAS_PIXEL_BYTES")){
   const auto result=UNSAFE_BUFFERS(std::from_chars(text,text+std::strlen(text),bytes));
   if(result.ec!=std::errc()||*result.ptr!='\0'||bytes<32*1024*1024||bytes>size_t{2}*1024*1024*1024)bytes=0;
  }
  return new CanvasPixelPool(bytes);
 }();return *pool;
}
bool CanvasPixelSize(int width,int height,size_t* bytes){
 if(width<=0||height<=0||width>8192||height>8192)return false;
 const size_t size=size_t(width)*size_t(height)*4;
 if(size>64*1024*1024)return false;*bytes=size;return true;
}
sk_sp<SkData> AllocateCanvasPixels(CanvasPixelPool& pool,size_t bytes,std::string* error){
 if(bytes==0||bytes>64*1024*1024){*error="Canvas image exceeds decoded budget";return {};}
 // Small owner/SkData/image-wrapper allowance is conservative metadata,
 // distinct from requested pixel bytes and whole allocator/VM residency.
 auto lease=pool.Reserve(bytes+1024,error);if(!lease)return {};
 struct Owner {std::shared_ptr<void> lease;std::unique_ptr<uint8_t[]> pixels;};
 auto owner=std::make_unique<Owner>();owner->lease=std::move(lease);
 owner->pixels=std::make_unique_for_overwrite<uint8_t[]>(bytes);
 auto* address=owner->pixels.get();auto* context=owner.release();
 return SkData::MakeWithProc(address,bytes,[](const void*,void* value){delete static_cast<Owner*>(value);},context);
}
bool CopyCanvasPixmap(const SkPixmap& source,const SkImageInfo& destination,SkData* pixels,std::string* error){
 if(!pixels||pixels->size()!=destination.computeMinByteSize()||
    !source.readPixels(destination,pixels->writable_data(),destination.minRowBytes(),0,0)){
  *error="Canvas software pixel conversion failed";return false;}
 return true;
}
sk_sp<SkPicture> CanvasPicture(sk_sp<SkImage> image,int width,int height,
    const std::array<float,4>& uv,bool flip_y,bool nearest,SkColor4f background,std::string* error){
 if(!image||image->isTextureBacked()||width<=0||height<=0||width>8192||height>8192){*error="Invalid Canvas picture geometry";return {};}
 for(float value:uv)if(!std::isfinite(value)||value<0||value>1){*error="Invalid Canvas texture coordinates";return {};}
 if(uv[0]==uv[2]||uv[1]==uv[3]){*error="Empty Canvas texture coordinates";return {};}
 SkPictureRecorder recorder;auto* canvas=recorder.beginRecording(width,height);
 const bool reverse_x=uv[2]<uv[0],reverse_y=(uv[3]<uv[1])!=flip_y;
 if(reverse_x){canvas->translate(width,0);canvas->scale(-1,1);}
 if(reverse_y){canvas->translate(0,height);canvas->scale(1,-1);}
 const auto destination=SkRect::MakeWH(width,height);
 if(background.fA>0){SkPaint paint;paint.setColor4f(background);canvas->drawRect(destination,paint);}
 const auto source=SkRect::MakeLTRB(std::min(uv[0],uv[2])*image->width(),std::min(uv[1],uv[3])*image->height(),std::max(uv[0],uv[2])*image->width(),std::max(uv[1],uv[3])*image->height());
 canvas->drawImageRect(image.get(),source,destination,SkSamplingOptions(nearest?SkFilterMode::kNearest:SkFilterMode::kLinear),nullptr,SkCanvas::kStrict_SrcRectConstraint);
 return recorder.finishRecordingAsPicture();
}
}
