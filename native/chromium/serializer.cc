#include "components/remote_paint/serializer.h"

#include <algorithm>
#include <vector>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <span>
#include <utility>

#include "components/remote_paint/font_subset.h"
#include "third_party/skia/include/core/SkImage.h"
#include "third_party/skia/include/core/SkPaint.h"
#include "third_party/skia/include/core/SkSerialProcs.h"
#include "third_party/skia/include/core/SkStream.h"
#include "third_party/skia/include/core/SkString.h"
#include "third_party/skia/include/core/SkTextBlob.h"
#include "third_party/skia/include/core/SkTypeface.h"
#include "third_party/skia/include/utils/SkNoDrawCanvas.h"
#include "third_party/skia/include/utils/SkNWayCanvas.h"
#include "third_party/skia/include/core/SkPictureRecorder.h"
#include "third_party/skia/include/core/SkPath.h"
#include "third_party/skia/include/core/SkSurface.h"
#include "third_party/skia/include/core/SkColorSpace.h"
#include "third_party/skia/src/core/SkTextBlobPriv.h"
#include <chrono>
#include <ratio>
#include "third_party/skia/include/core/SkBlender.h"
#if defined(REMOTE_PAINT_CHROMIUM)
#include "base/compiler_specific.h"
#include "third_party/skia/include/encode/SkPngRustEncoder.h"
#else
#include "third_party/skia/include/encode/SkPngEncoder.h"
#define UNSAFE_BUFFERS(...) __VA_ARGS__
#endif

namespace remote_paint {
namespace {
double NowMs(){return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();}

// Analysis only: no pixels are allocated. Preserve every glyph in the record,
// including clipped/off-viewport glyphs, because the full record is serialized.
class GlyphCollector final : public SkNoDrawCanvas {
 public:
  GlyphCollector() : SkNoDrawCanvas(SkIRect::MakeLTRB(-100000000, -100000000,
                                                  100000000, 100000000)) {}
  std::map<SkTypefaceID, std::set<SkGlyphID>> glyphs;
  std::map<SkTypefaceID, size_t> missing_glyphs;

 protected:
  void onDrawTextBlob(const SkTextBlob* blob, SkScalar, SkScalar,
                      const SkPaint&) override {
    SkTextBlob::Iter::Run run;
    for (SkTextBlob::Iter it(*blob); it.next(&run);) {
      if (!run.fTypeface || run.fGlyphCount <= 0) continue;
      auto& used = glyphs[run.fTypeface->uniqueID()];
      used.insert(0);
      // SAFETY: SkTextBlob::Iter guarantees fGlyphCount valid glyph indices.
      const auto ids = std::span(run.fGlyphIndices, static_cast<size_t>(run.fGlyphCount));
      used.insert(ids.begin(), ids.end());
      for (auto glyph : ids) if (!glyph) missing_glyphs[run.fTypeface->uniqueID()]++;
    }
  }
  void onDrawPicture(const SkPicture* picture, const SkMatrix*,
                     const SkPaint*) override { picture->playback(this); }
  void onClipRect(const SkRect&, SkClipOp, ClipEdgeStyle) override {}
  void onClipRRect(const SkRRect&, SkClipOp, ClipEdgeStyle) override {}
  void onClipPath(const SkPath&, SkClipOp, ClipEdgeStyle) override {}
  void onClipRegion(const SkRegion&, SkClipOp) override {}
};

class IsolationCollector final : public SkNoDrawCanvas {
 public:
  IsolationCollector() : SkNoDrawCanvas(SkIRect::MakeLTRB(-100000000, -100000000,
                                                           100000000, 100000000)) {}
  bool requires_isolation = false;

 protected:
  SaveLayerStrategy getSaveLayerStrategy(const SaveLayerRec&) override {
    requires_isolation = true;
    return kNoLayer_SaveLayerStrategy;
  }
  void onDrawPaint(const SkPaint& paint) override { Check(paint); }
  void onDrawRect(const SkRect&, const SkPaint& paint) override { Check(paint); }
  void onDrawRRect(const SkRRect&, const SkPaint& paint) override { Check(paint); }
  void onDrawOval(const SkRect&, const SkPaint& paint) override { Check(paint); }
  void onDrawDRRect(const SkRRect&, const SkRRect&, const SkPaint& paint) override { Check(paint); }
  void onDrawArc(const SkRect&, SkScalar, SkScalar, bool, const SkPaint& paint) override { Check(paint); }
  void onDrawBehind(const SkPaint&) override { requires_isolation = true; }
  bool onDoSaveBehind(const SkRect*) override { requires_isolation = true; return false; }
  void onDrawDrawable(SkDrawable*, const SkMatrix*) override { requires_isolation = true; }
  void onDrawShadowRec(const SkPath&, const SkDrawShadowRec&) override { requires_isolation = true; }
  void onDrawMesh(const SkMesh&, sk_sp<SkBlender>, const SkPaint&) override { requires_isolation = true; }
  void onDrawVerticesObject(const SkVertices*, SkBlendMode, const SkPaint&) override { requires_isolation = true; }
  void onDrawPatch(const SkPoint[12], const SkColor[4], const SkPoint[4], SkBlendMode, const SkPaint&) override { requires_isolation = true; }
  void onDrawEdgeAAQuad(const SkRect&, const SkPoint[4], QuadAAFlags, const SkColor4f&, SkBlendMode mode) override { if(mode!=SkBlendMode::kSrcOver) requires_isolation = true; }
  void onDrawEdgeAAImageSet2(const ImageSetEntry[], int, const SkPoint[], const SkMatrix[], const SkSamplingOptions&, const SkPaint* paint, SrcRectConstraint) override { if(paint) Check(*paint); }
  void onDrawPath(const SkPath&, const SkPaint& paint) override { Check(paint); }
  void onDrawRegion(const SkRegion&, const SkPaint& paint) override { Check(paint); }
  void onDrawPoints(PointMode, size_t, const SkPoint[], const SkPaint& paint) override { Check(paint); }
  void onDrawTextBlob(const SkTextBlob*, SkScalar, SkScalar, const SkPaint& paint) override { Check(paint); }
  void onDrawImage2(const SkImage*, SkScalar, SkScalar, const SkSamplingOptions&, const SkPaint* paint) override { if (paint) Check(*paint); }
  void onDrawImageRect2(const SkImage*, const SkRect&, const SkRect&, const SkSamplingOptions&, const SkPaint* paint, SrcRectConstraint) override { if (paint) Check(*paint); }
  void onDrawImageLattice2(const SkImage*, const Lattice&, const SkRect&, SkFilterMode, const SkPaint* paint) override { if (paint) Check(*paint); }
  void onDrawAtlas2(const SkImage*, const SkRSXform[], const SkRect[], const SkColor[], int, SkBlendMode mode, const SkSamplingOptions&, const SkRect*, const SkPaint* paint) override {
    if (mode != SkBlendMode::kSrcOver) requires_isolation = true;
    if (paint) Check(*paint);
  }
  void onDrawPicture(const SkPicture* picture, const SkMatrix*, const SkPaint* paint) override {
    if (paint) Check(*paint);
    if (picture) picture->playback(this);
  }

 private:
  void Check(const SkPaint& paint) {
    if (paint.getBlendMode_or(SkBlendMode::kSrc) != SkBlendMode::kSrcOver) requires_isolation = true;
  }
};

// Bitmap-only glyphs (such as Apple Color Emoji) depend on native strike
// selection. Preserve their source pixels; outline fonts keep subset glyphs.
class PortableTextCanvas final : public SkNWayCanvas {
 public:
  PortableTextCanvas(SkCanvas* target, int width, int height) : SkNWayCanvas(width,height) { addCanvas(target); }
  size_t bitmap_glyphs=0;
  size_t bitmap_pixels=0;
  std::string error;
 protected:
  void onDrawPicture(const SkPicture* picture, const SkMatrix* matrix, const SkPaint* paint) override {
    SkCanvas::onDrawPicture(picture,matrix,paint);
  }
  void onDrawTextBlob(const SkTextBlob* blob, SkScalar x, SkScalar y, const SkPaint& paint) override {
    bool has_bitmap=false;
    for (SkTextBlobRunIterator it(blob); !it.done()&&!has_bitmap; it.next()) {
      for(size_t i=0;i<it.glyphCount();i++) {
        // Iter guarantees glyphCount initialized glyphs and positions.
        const auto glyph=UNSAFE_BUFFERS(it.glyphs()[i]);SkRect bounds;
        it.font().getBounds({&glyph,1},{&bounds,1},&paint);
        if(!bounds.isEmpty()&&!it.font().getPath(glyph)){has_bitmap=true;break;}
      }
    }
    if(!has_bitmap){SkNWayCanvas::onDrawTextBlob(blob,x,y,paint);return;}
    for (SkTextBlobRunIterator it(blob); !it.done(); it.next()) {
      const auto count=it.glyphCount();const auto& font=it.font();
      const auto glyphs=UNSAFE_BUFFERS(std::span(it.glyphs(),count));
      std::vector<SkPoint> positions(count);
      if(it.positioning()==SkTextBlobRunIterator::kRSXform_Positioning) {
        error="RSXform text mixed with bitmap glyphs is unsupported";return;
      }
      switch(it.positioning()) {
        case SkTextBlobRunIterator::kDefault_Positioning:font.getPos(glyphs,positions,it.offset());break;
        case SkTextBlobRunIterator::kHorizontal_Positioning:
          for(size_t i=0;i<count;i++) positions[i]=SkPoint::Make(UNSAFE_BUFFERS(it.pos()[i]),it.offset().y());break;
        case SkTextBlobRunIterator::kFull_Positioning:
          UNSAFE_BUFFERS(std::copy_n(it.points(),count,positions.data()));break;
        default:break;
      }
      for(size_t i=0;i<count;i++) {
        auto one=SkTextBlob::MakeFromPosText(&glyphs[i],sizeof(SkGlyphID),std::span(&positions[i],1),font,SkTextEncoding::kGlyphID);
        SkRect bounds;font.getBounds({&glyphs[i],1},{&bounds,1},&paint);
        if(!bounds.isEmpty()&&!font.getPath(glyphs[i])) {
          const float origin_x=x+positions[i].x(),origin_y=y+positions[i].y();
          const auto area=bounds.makeOffset(origin_x,origin_y).roundOut().makeOutset(1,1);
          if(area.width()>1024||area.height()>1024||bitmap_glyphs>=4096||
             (bitmap_pixels+=static_cast<size_t>(area.width())*area.height())>16*1024*1024){error="Bitmap glyph exceeds pixel budget";return;}
          auto surface=SkSurfaces::Raster(SkImageInfo::MakeN32Premul(area.width(),area.height(),SkColorSpace::MakeSRGB()));
          if(!surface){error="Bitmap glyph allocation failed";return;}
          surface->getCanvas()->clear(SK_ColorTRANSPARENT);
          surface->getCanvas()->drawTextBlob(one.get(),x-area.x(),y-area.y(),paint);
          auto image=surface->makeImageSnapshot();
          if(!image){error="Bitmap glyph snapshot failed";return;}
          SkNWayCanvas::onDrawImage2(image.get(),area.x(),area.y(),SkSamplingOptions(),nullptr);bitmap_glyphs++;
        } else SkNWayCanvas::onDrawTextBlob(one.get(),x,y,paint);
      }
    }
  }
};

// Independent immutable asset caches survive changes to surrounding text and
// tile recordings. Locks cover map operations only; font/image encoding remains
// parallel across worker tasks. Both entry count and retained bytes are bounded.
struct FontAsset {
  sk_sp<SkTypeface> face;
  std::set<SkGlyphID> glyphs;
  sk_sp<const SkData> bytes;
  FontStats stats;
};
struct ImageAsset { sk_sp<SkImage> image; sk_sp<const SkData> bytes; };
struct AssetCache {
  std::mutex mutex;
  std::vector<FontAsset> fonts;
  std::map<uint32_t,ImageAsset> images;
  size_t retained_bytes = 0;
};
AssetCache& Assets(){static auto* cache=new AssetCache;return *cache;}
sk_sp<const SkData> LookupFont(SkTypeface* face,const std::set<SkGlyphID>& glyphs,FontStats* stats){
  auto& cache=Assets();std::lock_guard lock(cache.mutex);
  for(const auto& entry:cache.fonts)if(entry.face->uniqueID()==face->uniqueID()&&std::includes(entry.glyphs.begin(),entry.glyphs.end(),glyphs.begin(),glyphs.end())){*stats=entry.stats;return entry.bytes;}
  return nullptr;
}
void CacheFont(SkTypeface* face,const std::set<SkGlyphID>& glyphs,sk_sp<const SkData> bytes,const FontStats& stats){
  auto& cache=Assets();std::lock_guard lock(cache.mutex);const size_t retained=bytes->size()+stats.original_bytes;
  if(retained>64*1024*1024)return;
  if(cache.retained_bytes+retained>64*1024*1024||cache.fonts.size()>=128){cache.fonts.clear();cache.images.clear();cache.retained_bytes=0;}
  cache.fonts.push_back({sk_ref_sp(face),glyphs,std::move(bytes),stats});cache.retained_bytes+=retained;
}
sk_sp<const SkData> LookupImage(SkImage* image){auto& cache=Assets();std::lock_guard lock(cache.mutex);auto found=cache.images.find(image->uniqueID());return found==cache.images.end()?nullptr:found->second.bytes;}
void CacheImage(SkImage* image,sk_sp<const SkData> bytes){
  auto& cache=Assets();std::lock_guard lock(cache.mutex);if(cache.images.contains(image->uniqueID()))return;
  const size_t retained=bytes->size()+image->imageInfo().computeMinByteSize();if(retained>64*1024*1024)return;
  if(cache.retained_bytes+retained>64*1024*1024||cache.images.size()>=128){cache.images.clear();cache.fonts.clear();cache.retained_bytes=0;}
  cache.images.emplace(image->uniqueID(),ImageAsset{sk_ref_sp(image),std::move(bytes)});cache.retained_bytes+=retained;
}

struct Context {
  GlyphCollector collector;
  std::vector<std::pair<std::string,sk_sp<const SkData>>> assets;
  SerializedPicture result;
  size_t budget;
  std::map<SkTypefaceID, sk_sp<const SkData>> fonts;
};

SkSerialReturnType SerializeTypeface(SkTypeface* typeface, void* opaque) {
  auto& ctx = *static_cast<Context*>(opaque);
  const auto started = NowMs();
  auto existing = ctx.fonts.find(typeface->uniqueID());
  if (existing != ctx.fonts.end()) {
    ctx.result.font_ms += (NowMs() - started);
    return existing->second;
  }
  const auto found = ctx.collector.glyphs.find(typeface->uniqueID());
  if (found == ctx.collector.glyphs.end()) {
    ctx.result.error = "Typeface was not visited by the glyph collector";
    ctx.result.font_ms += (NowMs() - started);
    return SkData::MakeEmpty();
  }
  FontStats cached_stats;
  if(auto cached=LookupFont(typeface,found->second,&cached_stats)){
    if(cached->size()>ctx.budget){ctx.result.error="Cached font exceeds byte budget";return SkData::MakeEmpty();}
    cached_stats.glyphs=found->second.size();cached_stats.missing_glyphs=ctx.collector.missing_glyphs[typeface->uniqueID()];
    ctx.assets.emplace_back("font",cached);
    ctx.result.fonts.push_back(cached_stats);ctx.fonts.emplace(typeface->uniqueID(),cached);ctx.result.font_cache_hits++;
    ctx.result.font_ms+=(NowMs()-started);return cached;
  }
  // Retain the source glyph IDs and the source variation coordinates.
  // Failure is explicit: never silently omit a font or use a client fallback.
  std::string subset_error;
  auto subset = SubsetTypeface(typeface, found->second, &subset_error);
  if (!subset || subset->size() > ctx.budget) {
    SkString family; typeface->getFamilyName(&family);
    ctx.result.error = std::string("Typeface ") + family.c_str() + ": " +
      (subset ? "subset exceeds byte budget" : subset_error);
    ctx.result.font_ms += (NowMs() - started);
    return SkData::MakeEmpty();
  }
  SkString name;
  typeface->getFamilyName(&name);
  int collection_index = 0;
  auto original = typeface->openStream(&collection_index);
  ctx.result.fonts.push_back({name.c_str(), found->second.size(),
                             original ? original->getLength() : 0,
                             subset->size(), ctx.collector.missing_glyphs[typeface->uniqueID()]});
  ctx.assets.emplace_back("font",subset);
  CacheFont(typeface,found->second,subset,ctx.result.fonts.back());
  ctx.fonts.emplace(typeface->uniqueID(), subset);
  ctx.result.font_ms += (NowMs() - started);
  return subset;
}

SkSerialReturnType SerializeImage(SkImage* image, void* opaque) {
  auto& ctx = *static_cast<Context*>(opaque);
  const auto started = NowMs();
  const auto finish = [&] {
    ctx.result.image_ms += (NowMs() - started);
  };
  const auto info = image->imageInfo();
  if (image->isTextureBacked() || info.width() > 8192 || info.height() > 8192 ||
      info.computeMinByteSize() > 64 * 1024 * 1024) {
    ctx.result.error = "Image requires GPU readback or exceeds decoded budget";
    finish();
    return SkData::MakeEmpty();
  }
  if(auto cached=LookupImage(image)){
    if(cached->size()>ctx.budget-ctx.result.image_bytes){ctx.result.error="Cached image exceeds byte budget";finish();return SkData::MakeEmpty();}
    ctx.assets.emplace_back("image",cached);
    ctx.result.image_bytes+=cached->size();ctx.result.image_count++;ctx.result.image_cache_hits++;finish();return cached;
  }
  // Read pixels already fetched by the browser, including authenticated/blob
  // images. The Viewer never receives a URL and never refetches source assets.
#if defined(REMOTE_PAINT_CHROMIUM)
  auto encoded = SkPngRustEncoder::Encode(nullptr, image, {});
#else
  auto encoded = SkPngEncoder::Encode(nullptr, image, {});
#endif
  if (!encoded || encoded->size() > ctx.budget - ctx.result.image_bytes) {
    ctx.result.error = "Image encoding failed or exceeded byte budget";
    finish();
    return SkData::MakeEmpty();
  }
  ctx.assets.emplace_back("image",encoded);
  CacheImage(image,encoded);
  ctx.result.image_bytes += encoded->size();
  ctx.result.image_count++;
  finish();
  return encoded;
}

}  // namespace

SerializedPicture SerializePicture(const SkPicture& picture, size_t byte_budget) {
  Context ctx;
  ctx.budget = byte_budget;
  SkPictureRecorder recorder;
  const auto bounds=picture.cullRect();
  const auto portable_started = NowMs();
  auto* target=recorder.beginRecording(bounds);
  PortableTextCanvas portable(target,bounds.width(),bounds.height());
  picture.playback(&portable);
  ctx.result.portable_ms = (NowMs() - portable_started);
  if(!portable.error.empty()){ctx.result.error=portable.error;return std::move(ctx.result);}
  ctx.result.bitmap_glyphs=portable.bitmap_glyphs;
  auto normalized=recorder.finishRecordingAsPicture();
  IsolationCollector isolation;
  normalized->playback(&isolation);
  ctx.result.requires_isolation = isolation.requires_isolation;
  const auto glyph_started = NowMs();
  normalized->playback(&ctx.collector);
  ctx.result.glyph_collection_ms = (NowMs() - glyph_started);
  SkSerialProcs procs;
  procs.fTypefaceProc = SerializeTypeface;
  procs.fTypefaceCtx = &ctx;
  procs.fImageProc = SerializeImage;
  procs.fImageCtx = &ctx;
  const auto serialize_started = NowMs();
  auto data = normalized->serialize(&procs);
  ctx.result.serialize_ms = (NowMs() - serialize_started);
  if (!data || data->size() > byte_budget) ctx.result.error = "Picture exceeds byte budget";
  if (ctx.result.error.empty()) {
    const auto bytes=UNSAFE_BUFFERS(std::span(static_cast<const uint8_t*>(data->data()),data->size()));
    for(const auto& [kind,asset]:ctx.assets){
      const auto pattern=UNSAFE_BUFFERS(std::span(static_cast<const uint8_t*>(asset->data()),asset->size()));
      if(pattern.size()<16)continue;
      auto begin=bytes.begin();
      while(ctx.result.asset_ranges.size()<256){
        auto found=std::search(begin,bytes.end(),pattern.begin(),pattern.begin()+16);
        if(found==bytes.end())break;
        const size_t offset=found-bytes.begin();
        if(offset+pattern.size()<=bytes.size()&&std::equal(pattern.begin(),pattern.end(),found))ctx.result.asset_ranges.push_back({offset,pattern.size(),kind});
        begin=found+1;
      }
    }
    std::sort(ctx.result.asset_ranges.begin(),ctx.result.asset_ranges.end(),[](const auto& a,const auto& b){return a.offset<b.offset;});
    ctx.result.asset_ranges.erase(std::unique(ctx.result.asset_ranges.begin(),ctx.result.asset_ranges.end(),[](const auto& a,const auto& b){return a.offset==b.offset;}),ctx.result.asset_ranges.end());
    ctx.result.bytes=std::move(data);
  }
  return std::move(ctx.result);
}

}  // namespace remote_paint
