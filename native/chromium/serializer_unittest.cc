#include "components/remote_paint/serializer.h"

#include <cstring>
#include <optional>
#include "third_party/skia/include/core/SkImage.h"
#include "third_party/skia/include/core/SkSerialProcs.h"
#include <string>

#include "base/compiler_specific.h"
#include "build/build_config.h"
#include "skia/ext/font_utils.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/skia/include/core/SkCanvas.h"
#include "third_party/skia/include/core/SkColorSpace.h"
#include "third_party/skia/include/core/SkFont.h"
#include "third_party/skia/include/core/SkFontMgr.h"
#include "third_party/skia/include/core/SkPictureRecorder.h"
#include "third_party/skia/include/core/SkSurface.h"
#include "third_party/skia/include/core/SkTextBlob.h"
#include "third_party/skia/include/core/SkTypeface.h"

namespace remote_paint {
namespace {
#if BUILDFLAG(IS_MAC)
constexpr char kTextFamily[] = "Arial";
constexpr char kColorFamily[] = "Apple Color Emoji";
#else
constexpr char kTextFamily[] = "DejaVu Sans";
constexpr char kColorFamily[] = "Noto Color Emoji";
#endif
sk_sp<SkPicture> TextPicture(const std::string& text, const char* family) {
  auto face = skia::DefaultFontMgr()->matchFamilyStyle(family, SkFontStyle());
  EXPECT_TRUE(face);
  SkFont font(face, 24);
  auto blob = SkTextBlob::MakeFromText(text.data(), text.size(), font);
  EXPECT_TRUE(blob);
  SkPictureRecorder recorder;
  auto* canvas = recorder.beginRecording(640, 80);
  canvas->clear(SK_ColorWHITE);
  canvas->drawTextBlob(blob, 4, 36, SkPaint());
  return recorder.finishRecordingAsPicture();
}

TEST(RemotePaintSerializer, RetainsOriginalGlyphIdsAndPixels) {
  const auto original = TextPicture("Remote Paint glyph IDs 1579", kTextFamily);
  const auto encoded = SerializePicture(*original);
  ASSERT_TRUE(encoded.error.empty()) << encoded.error;
  ASSERT_TRUE(encoded.bytes);
  ASSERT_EQ(encoded.fonts.size(), 1u);
  EXPECT_LT(encoded.fonts[0].subset_bytes, encoded.fonts[0].original_bytes);
  auto decoded = SkPicture::MakeFromData(encoded.bytes->data(), encoded.bytes->size());
  ASSERT_TRUE(decoded);
  auto a = SkSurfaces::Raster(SkImageInfo::MakeN32Premul(640, 80));
  auto b = SkSurfaces::Raster(SkImageInfo::MakeN32Premul(640, 80));
  a->getCanvas()->drawPicture(original);
  b->getCanvas()->drawPicture(decoded);
  SkPixmap pa, pb;
  ASSERT_TRUE(a->peekPixels(&pa));
  ASSERT_TRUE(b->peekPixels(&pb));
  ASSERT_EQ(pa.computeByteSize(), pb.computeByteSize());
  // Both live raster surfaces expose exactly the validated pixmap byte size.
  EXPECT_EQ(UNSAFE_BUFFERS(std::memcmp(pa.addr(), pb.addr(), pa.computeByteSize())), 0);
}

TEST(RemotePaintSerializer, BitmapEmojiKeepsOriginalNativePixels) {
  const auto original = TextPicture("🌈", kColorFamily);
  const auto encoded = SerializePicture(*original);
  ASSERT_TRUE(encoded.error.empty()) << encoded.error;
  ASSERT_TRUE(encoded.bytes);
  ASSERT_GT(encoded.bitmap_glyphs,0u);
  ASSERT_GT(encoded.image_count,0u);
  SkDeserialProcs procs;
  procs.fImageProc=[](const void* data,size_t size,std::optional<SkAlphaType> alpha,void*) {
    return SkImages::DeferredFromEncodedData(SkData::MakeWithCopy(data,size),alpha);
  };
  auto decoded = SkPicture::MakeFromData(encoded.bytes->data(),encoded.bytes->size(),&procs);
  ASSERT_TRUE(decoded);
  auto a=SkSurfaces::Raster(SkImageInfo::MakeN32Premul(640,80,SkColorSpace::MakeSRGB()));
  auto b=SkSurfaces::Raster(SkImageInfo::MakeN32Premul(640,80,SkColorSpace::MakeSRGB()));
  a->getCanvas()->drawPicture(original);b->getCanvas()->drawPicture(decoded);
  SkPixmap pa,pb;ASSERT_TRUE(a->peekPixels(&pa));ASSERT_TRUE(b->peekPixels(&pb));
  EXPECT_EQ(UNSAFE_BUFFERS(std::memcmp(pa.addr(),pb.addr(),pa.computeByteSize())),0);
}

TEST(RemotePaintSerializer, RefusesSmallBudgetInsteadOfDroppingFont) {
  const auto original = TextPicture("This font must be included", kTextFamily);
  const auto encoded = SerializePicture(*original, 100);
  EXPECT_FALSE(encoded.bytes);
  EXPECT_FALSE(encoded.error.empty());
}

TEST(RemotePaintSerializer, IsolationAnalysisPreservesDestructiveBlendSemantics) {
  SkPictureRecorder recorder;
  auto* canvas = recorder.beginRecording(100, 100);
  SkPaint paint;
  paint.setColor(SK_ColorRED);
  canvas->drawRect(SkRect::MakeWH(20, 20), paint);
  auto safe = recorder.finishRecordingAsPicture();
  auto direct = SerializePicture(*safe);
  ASSERT_TRUE(direct.bytes);
  EXPECT_FALSE(direct.requires_isolation);
  canvas = recorder.beginRecording(100, 100);
  canvas->clear(SK_ColorTRANSPARENT);
  canvas->drawPicture(safe);
  auto clear = recorder.finishRecordingAsPicture();
  EXPECT_TRUE(SerializePicture(*clear).requires_isolation);
  canvas = recorder.beginRecording(100, 100);
  paint.setBlendMode(SkBlendMode::kSrc);
  canvas->drawOval(SkRect::MakeWH(20, 20), paint);
  auto source = recorder.finishRecordingAsPicture();
  EXPECT_TRUE(SerializePicture(*source).requires_isolation);
  canvas = recorder.beginRecording(100, 100);
  canvas->saveLayer(nullptr, nullptr);
  canvas->drawPicture(safe);
  canvas->restore();
  auto layer = recorder.finishRecordingAsPicture();
  EXPECT_TRUE(SerializePicture(*layer).requires_isolation);
}

TEST(RemotePaintSerializer, NestedPicturesKeepTheirFontCoverage) {
  auto child = TextPicture("Nested child text", kTextFamily);
  SkPictureRecorder recorder;
  auto* canvas = recorder.beginRecording(640, 160);
  canvas->drawPicture(child);
  canvas->translate(0, 80);
  canvas->drawPicture(child);
  auto parent = recorder.finishRecordingAsPicture();
  const auto encoded = SerializePicture(*parent);
  EXPECT_TRUE(encoded.error.empty()) << encoded.error;
  EXPECT_TRUE(encoded.bytes);
  EXPECT_EQ(encoded.fonts.size(), 1u);
}
}  // namespace
}  // namespace remote_paint
