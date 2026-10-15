#include "components/remote_paint/serializer.h"

#include <cstring>
#include <string>

#include "skia/ext/font_utils.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/skia/include/core/SkCanvas.h"
#include "third_party/skia/include/core/SkFont.h"
#include "third_party/skia/include/core/SkFontMgr.h"
#include "third_party/skia/include/core/SkPictureRecorder.h"
#include "third_party/skia/include/core/SkSurface.h"
#include "third_party/skia/include/core/SkTextBlob.h"
#include "third_party/skia/include/core/SkTypeface.h"

namespace remote_paint {
namespace {
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
  const auto original = TextPicture("Remote Paint glyph IDs 1579", "Arial");
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
  EXPECT_EQ(std::memcmp(pa.addr(), pb.addr(), pa.computeByteSize()), 0);
}

TEST(RemotePaintSerializer, RefusesSmallBudgetInsteadOfDroppingFont) {
  const auto original = TextPicture("This font must be included", "Arial");
  const auto encoded = SerializePicture(*original, 100);
  EXPECT_FALSE(encoded.bytes);
  EXPECT_FALSE(encoded.error.empty());
}

TEST(RemotePaintSerializer, NestedPicturesKeepTheirFontCoverage) {
  auto child = TextPicture("Nested child text", "Arial");
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
