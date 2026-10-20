// The HarfBuzz subset policy follows Chromium's BSD-licensed
// components/paint_preview/common/subset_font.cc (Copyright 2019 The Chromium Authors).
#include "components/remote_paint/font_subset.h"
#include <hb.h>
#include <hb-subset.h>
#include <limits>
#include <memory>
#include <vector>
#include <cmath>
#include "third_party/skia/include/core/SkFont.h"
#include "third_party/skia/include/core/SkStream.h"
#if defined(REMOTE_PAINT_CHROMIUM)
#include "skia/ext/font_utils.h"
#include "third_party/skia/include/ports/SkTypeface_fontations.h"
#else
#include "third_party/skia/include/ports/SkFontMgr_mac_ct.h"
#endif

namespace remote_paint {
sk_sp<SkFontMgr> FontManager() {
#if defined(REMOTE_PAINT_CHROMIUM)
  return skia::DefaultFontMgr();
#else
  static auto manager = SkFontMgr_New_CoreText(nullptr);
  return manager;
#endif
}

sk_sp<SkData> SubsetTypeface(SkTypeface* typeface, const std::set<SkGlyphID>& glyphs, std::string* error, size_t* glyph_slots) {
  if(glyph_slots)*glyph_slots=0;
  auto fail = [error](const char* stage) -> sk_sp<SkData> { if (error) *error = stage; return nullptr; };
  int index = 0;
  auto stream = typeface->openStream(&index);
  if (!stream || stream->getLength() > std::numeric_limits<unsigned int>::max()) return fail("source stream unavailable or too large");
  auto data = SkData::MakeFromStream(stream.get(), stream->getLength());
  if (!data) return fail("source stream read failed");
  auto blob = std::unique_ptr<hb_blob_t, decltype(&hb_blob_destroy)>(
      hb_blob_create(static_cast<const char*>(data->data()), data->size(), HB_MEMORY_MODE_READONLY,
                     nullptr, nullptr), hb_blob_destroy);
  auto face = std::unique_ptr<hb_face_t, decltype(&hb_face_destroy)>(hb_face_create(blob.get(), index), hb_face_destroy);
  auto input = std::unique_ptr<hb_subset_input_t, decltype(&hb_subset_input_destroy)>(
      hb_subset_input_create_or_fail(), hb_subset_input_destroy);
  if (!face || !input) return fail("HarfBuzz input allocation failed");
  hb_set_clear(hb_subset_input_unicode_set(input.get()));
  for (auto glyph : glyphs) hb_set_add(hb_subset_input_glyph_set(input.get()), glyph);
  hb_subset_input_set_flags(input.get(), HB_SUBSET_FLAGS_RETAIN_GIDS);
  // Let modern HarfBuzz subset variation/layout tables with the retained IDs.
  // Passing gvar through unchanged would retain almost all of .SF NS (~7 MiB).
  // Restore the source typeface's variation coordinates on the result below.
  auto subset = std::unique_ptr<hb_face_t, decltype(&hb_face_destroy)>(hb_subset_or_fail(face.get(),input.get()),hb_face_destroy);
  if (!subset) return fail("HarfBuzz subset failed");
  auto subset_blob = std::unique_ptr<hb_blob_t, decltype(&hb_blob_destroy)>(hb_face_reference_blob(subset.get()),hb_blob_destroy);
  unsigned int size = 0;
  const char* bytes = hb_blob_get_data(subset_blob.get(), &size);
  if (!bytes || !size) return fail("subset blob empty");
  const int subset_index = hb_face_get_index(subset.get());
  auto result = FontManager()->makeFromData(SkData::MakeWithCopy(bytes,size), subset_index);
#if defined(REMOTE_PAINT_CHROMIUM)
  // macOS UI faces such as .PingFang UI SC may produce valid OpenType
  // subsets that CoreText refuses to register. Parse those exact subset bytes
  // with Chromium's Fontations backend; never resolve a substitute by name.
  if (!result) {
    SkFontArguments args;
    args.setCollectionIndex(subset_index);
    result = SkTypeface_Make_Fontations(SkData::MakeWithCopy(bytes,size), args);
  }
#endif
  if (!result) return fail("subset reload failed in native font backends");
  const int count = typeface->getVariationDesignPosition({});
  if (count > 0) {
    std::vector<SkFontArguments::VariationPosition::Coordinate> coordinates(count);
    if (typeface->getVariationDesignPosition(coordinates) != count) return fail("variation coordinates unavailable");
    SkFontArguments args;
    args.setCollectionIndex(subset_index);
    args.setVariationDesignPosition({coordinates.data(), count});
    result = result->makeClone(args);
    if (!result) return fail("variation clone failed");
  }
  // Retained IDs must still address the same advance metrics, including
  // variation coordinates. Validate this independently of antialiasing.
  SkFont source_font(sk_ref_sp(typeface), 64), subset_font(result, 64);
  for (auto glyph : glyphs) {
    if (glyph >= result->countGlyphs()) return fail("retained glyph outside subset");
    SkScalar source_width = 0, subset_width = 0;
    source_font.getWidths({&glyph, 1}, {&source_width, 1});
    subset_font.getWidths({&glyph, 1}, {&subset_width, 1});
    if (std::abs(source_width - subset_width) > 0.01f) return fail("retained glyph advance changed");
  }
  if(glyph_slots)*glyph_slots=result->countGlyphs();
  return result->serialize(SkTypeface::SerializeBehavior::kDoIncludeData);
}
}
