#include "components/remote_paint/serializer.h"

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
#if defined(REMOTE_PAINT_CHROMIUM)
#include "third_party/skia/include/encode/SkPngRustEncoder.h"
#else
#include "third_party/skia/include/encode/SkPngEncoder.h"
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
  auto subset = SubsetTypeface(typeface, found->second);
  if (!subset || subset->size() > ctx.budget) {
    ctx.result.error = "Typeface subsetting failed or exceeded byte budget";
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
  picture.playback(&ctx.collector);
  SkSerialProcs procs;
  procs.fTypefaceProc = SerializeTypeface;
  procs.fTypefaceCtx = &ctx;
  procs.fImageProc = SerializeImage;
  procs.fImageCtx = &ctx;
  auto data = picture.serialize(&procs);
  if (!data || data->size() > byte_budget) ctx.result.error = "Picture exceeds byte budget";
  if (ctx.result.error.empty()) ctx.result.bytes = std::move(data);
  return std::move(ctx.result);
}

}  // namespace remote_paint
