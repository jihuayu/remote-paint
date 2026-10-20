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
#include "components/remote_paint/asset_cache.h"
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

// Font and image pressure have separate budgets. Charges conservatively include
// retained source faces/pixels and key metadata, rather than only PNG/subset
// bytes. These are ownership estimates, not measurements of Skia/driver memory.
constexpr size_t kFontCacheBytes = 32 * 1024 * 1024;
constexpr size_t kImageCacheBytes = 32 * 1024 * 1024;
using FontKey = std::pair<SkTypefaceID, std::set<SkGlyphID>>;
struct FontAsset {
  sk_sp<SkTypeface> face;
  sk_sp<const SkData> bytes;
  FontStats stats;
  std::string error;
};
struct ImageAsset { sk_sp<SkImage> image; sk_sp<const SkData> bytes; };
struct AssetCache {
  AssetMemo<FontKey, FontAsset> fonts{kFontCacheBytes, 128};
  AssetMemo<uint32_t, ImageAsset> images{kImageCacheBytes, 128};
};
AssetCache& Assets(){static auto* cache=new AssetCache;return *cache;}
AssetMemo<FontKey, FontAsset>::Result FontEncoding(
    SkTypeface* face, const std::set<SkGlyphID>& glyphs) {
  return Assets().fonts.Get(FontKey{face->uniqueID(), glyphs},
      [&](const FontKey& key, const FontAsset&) {
        return key.first == face->uniqueID() &&
          std::includes(key.second.begin(), key.second.end(), glyphs.begin(), glyphs.end());
      }, [&] {
        auto asset = std::make_shared<FontAsset>(); asset->face = sk_ref_sp(face);
        SkString family; face->getFamilyName(&family);
        asset->stats.family = family.c_str(); asset->stats.glyphs = glyphs.size();
        size_t slots = 0; std::string error;
        asset->bytes = SubsetTypeface(face, glyphs, &error, &slots);
        if (!asset->bytes) {
          asset->error = std::string("Typeface ") + family.c_str() + ": " + error;
          return asset;
        }
        int collection_index = 0; auto original = face->openStream(&collection_index);
        asset->stats.original_bytes = original ? original->getLength() : 0;
        asset->stats.subset_bytes = asset->bytes->size(); asset->stats.glyph_slots = slots;
        return asset;
      }, [](const FontAsset& asset) -> std::optional<size_t> {
        if (!asset.bytes || asset.bytes->size() > kFontCacheBytes ||
            asset.stats.original_bytes > kFontCacheBytes) return std::nullopt;
        // Both LRU and map own a glyph-set key; charge node/storage overhead.
        return asset.bytes->size() + asset.stats.original_bytes +
          asset.stats.glyphs * 96 + asset.stats.family.size() * 2 + sizeof(FontAsset) + 256;
      });
}
AssetMemo<uint32_t, ImageAsset>::Result ImageEncoding(SkImage* image, bool retain_new_images) {
  return Assets().images.Get(image->uniqueID(),
      [](uint32_t, const ImageAsset&) { return false; }, [&] {
        auto asset = std::make_shared<ImageAsset>(); asset->image = sk_ref_sp(image);
#if defined(REMOTE_PAINT_CHROMIUM)
        asset->bytes = SkPngRustEncoder::Encode(nullptr, image, {});
#else
        asset->bytes = SkPngEncoder::Encode(nullptr, image, {});
#endif
        return asset;
      }, [retain_new_images](const ImageAsset& asset) -> std::optional<size_t> {
        if (!retain_new_images) return std::nullopt;
        if (!asset.bytes || asset.bytes->size() > kImageCacheBytes) return std::nullopt;
        return asset.bytes->size() + asset.image->imageInfo().computeMinByteSize() + sizeof(ImageAsset) + 256;
      });
}

struct Context {
  GlyphCollector collector;
  struct Asset { std::string kind; sk_sp<const SkData> bytes; size_t glyph_slots=0; };
  std::vector<Asset> assets;
  SerializedPicture result;
  size_t budget;
  bool retain_new_images = true;
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
  // Retain the source glyph IDs and the source variation coordinates.
  // Failure is explicit: never silently omit a font or use a client fallback.
  const auto encoding = FontEncoding(typeface, found->second);
  auto subset = encoding.value->bytes;
  if (!subset || subset->size() > ctx.budget) {
    ctx.result.error = subset ? "Font subset exceeds byte budget" : encoding.value->error;
    ctx.result.font_ms += (NowMs() - started);
    return SkData::MakeEmpty();
  }
  auto stats = encoding.value->stats;
  stats.glyphs = found->second.size();
  stats.missing_glyphs = ctx.collector.missing_glyphs[typeface->uniqueID()];
  ctx.result.fonts.push_back(std::move(stats));
  // RETAIN_GIDS leaves holes below the largest selected glyph. The slot
  // bound must describe the cached subset, not the number of glyphs used now.
  ctx.assets.push_back({"font",subset,ctx.result.fonts.back().glyph_slots});
  ctx.result.font_cache_hits += encoding.cache_hit;
  ctx.result.font_encoding_shares += encoding.shared_encoding;
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
  // Read pixels already fetched by the browser, including authenticated/blob
  // images. The Viewer never receives a URL and never refetches source assets.
  const auto encoding = ImageEncoding(image, ctx.retain_new_images);
  auto encoded = encoding.value->bytes;
  if (!encoded || encoded->size() > ctx.budget - ctx.result.image_bytes) {
    ctx.result.error = "Image encoding failed or exceeded byte budget";
    finish();
    return SkData::MakeEmpty();
  }
  ctx.assets.push_back({"image",encoded,0});
  ctx.result.image_cache_hits += encoding.cache_hit;
  ctx.result.image_encoding_shares += encoding.shared_encoding;
  ctx.result.image_bytes += encoded->size();
  ctx.result.image_count++;
  finish();
  return encoded;
}

}  // namespace

bool ClearSerializerAssetCachesForTesting() {
  return Assets().fonts.ClearForTesting() && Assets().images.ClearForTesting();
}

SerializerAssetCacheStats GetSerializerAssetCacheStats() {
  const auto fonts = Assets().fonts.stats();
  const auto images = Assets().images.stats();
  return {fonts.bytes, images.bytes, fonts.entries, images.entries,
          fonts.evictions, images.evictions, fonts.pending, images.pending,
          fonts.encodes, images.encodes, fonts.shares, images.shares,
          fonts.bypasses, images.bypasses};
}

SerializedPicture SerializePicture(const SkPicture& picture, size_t byte_budget, bool retain_new_images) {
  Context ctx;
  ctx.budget = byte_budget;
  ctx.retain_new_images = retain_new_images;
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
    std::map<size_t,AssetRange> indexed;
    for(const auto& [kind,asset,glyph_slots]:ctx.assets){
      const auto pattern=UNSAFE_BUFFERS(std::span(static_cast<const uint8_t*>(asset->data()),asset->size()));
      if(pattern.size()<16){ctx.result.error="Asset too small for complete index";return std::move(ctx.result);}
      auto begin=bytes.begin();bool located=false;
      while(true){
        auto found=std::search(begin,bytes.end(),pattern.begin(),pattern.begin()+16);
        if(found==bytes.end())break;
        const size_t offset=found-bytes.begin();
        if(offset+pattern.size()<=bytes.size()&&std::equal(pattern.begin(),pattern.end(),found)){
          located=true;auto [entry,inserted]=indexed.emplace(offset,AssetRange{offset,pattern.size(),kind,glyph_slots});
          if(!inserted&&(entry->second.bytes!=pattern.size()||entry->second.kind!=kind||entry->second.glyph_slots!=glyph_slots)){ctx.result.error="Conflicting serialized asset index";return std::move(ctx.result);}
          if(indexed.size()>256){ctx.result.error="Complete asset index exceeds range budget";return std::move(ctx.result);}
        }
        begin=found+1;
      }
      if(!located){ctx.result.error="Serialized asset missing from picture index";return std::move(ctx.result);}
    }
    size_t end=0;for(const auto& [offset,range]:indexed){if(offset<end){ctx.result.error="Overlapping complete asset index";return std::move(ctx.result);}ctx.result.asset_ranges.push_back(range);end=offset+range.bytes;}
    ctx.result.asset_ranges_complete=true;
    ctx.result.bytes=std::move(data);
  }
  return std::move(ctx.result);
}

}  // namespace remote_paint
