#include "components/remote_paint/serializer.h"

#include <algorithm>
#include <vector>
#include <map>
#include <memory>
#include <set>
#include <span>
#include <utility>

#include "components/remote_paint/font_subset.h"
#include "third_party/skia/include/core/SkImage.h"
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
#if defined(REMOTE_PAINT_CHROMIUM)
#include "base/compiler_specific.h"
#include "third_party/skia/include/encode/SkPngRustEncoder.h"
#else
#include "third_party/skia/include/encode/SkPngEncoder.h"
#define UNSAFE_BUFFERS(...) __VA_ARGS__
#endif

namespace remote_paint {
namespace {

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

struct Context {
  GlyphCollector collector;
  SerializedPicture result;
  size_t budget;
  std::map<SkTypefaceID, sk_sp<const SkData>> fonts;
};

SkSerialReturnType SerializeTypeface(SkTypeface* typeface, void* opaque) {
  auto& ctx = *static_cast<Context*>(opaque);
  auto existing = ctx.fonts.find(typeface->uniqueID());
  if (existing != ctx.fonts.end()) return existing->second;
  const auto found = ctx.collector.glyphs.find(typeface->uniqueID());
  if (found == ctx.collector.glyphs.end()) {
    ctx.result.error = "Typeface was not visited by the glyph collector";
    return SkData::MakeEmpty();
  }
  // Retain the source glyph IDs and the source variation coordinates.
  // Failure is explicit: never silently omit a font or use a client fallback.
  std::string subset_error;
  auto subset = SubsetTypeface(typeface, found->second, &subset_error);
  if (!subset || subset->size() > ctx.budget) {
    SkString family; typeface->getFamilyName(&family);
    ctx.result.error = std::string("Typeface ") + family.c_str() + ": " +
      (subset ? "subset exceeds byte budget" : subset_error);
    return SkData::MakeEmpty();
  }
  SkString name;
  typeface->getFamilyName(&name);
  int collection_index = 0;
  auto original = typeface->openStream(&collection_index);
  ctx.result.fonts.push_back({name.c_str(), found->second.size(),
                             original ? original->getLength() : 0,
                             subset->size(), ctx.collector.missing_glyphs[typeface->uniqueID()]});
  ctx.fonts.emplace(typeface->uniqueID(), subset);
  return subset;
}

SkSerialReturnType SerializeImage(SkImage* image, void* opaque) {
  auto& ctx = *static_cast<Context*>(opaque);
  const auto info = image->imageInfo();
  if (image->isTextureBacked() || info.width() > 8192 || info.height() > 8192 ||
      info.computeMinByteSize() > 64 * 1024 * 1024) {
    ctx.result.error = "Image requires GPU readback or exceeds decoded budget";
    return SkData::MakeEmpty();
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
    return SkData::MakeEmpty();
  }
  ctx.result.image_bytes += encoded->size();
  ctx.result.image_count++;
  return encoded;
}

}  // namespace

SerializedPicture SerializePicture(const SkPicture& picture, size_t byte_budget) {
  Context ctx;
  ctx.budget = byte_budget;
  SkPictureRecorder recorder;
  const auto bounds=picture.cullRect();
  auto* target=recorder.beginRecording(bounds);
  PortableTextCanvas portable(target,bounds.width(),bounds.height());
  picture.playback(&portable);
  if(!portable.error.empty()){ctx.result.error=portable.error;return std::move(ctx.result);}
  ctx.result.bitmap_glyphs=portable.bitmap_glyphs;
  auto normalized=recorder.finishRecordingAsPicture();
  normalized->playback(&ctx.collector);
  SkSerialProcs procs;
  procs.fTypefaceProc = SerializeTypeface;
  procs.fTypefaceCtx = &ctx;
  procs.fImageProc = SerializeImage;
  procs.fImageCtx = &ctx;
  auto data = normalized->serialize(&procs);
  if (!data || data->size() > byte_budget) ctx.result.error = "Picture exceeds byte budget";
  if (ctx.result.error.empty()) ctx.result.bytes = std::move(data);
  return std::move(ctx.result);
}

}  // namespace remote_paint
