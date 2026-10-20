#ifndef COMPONENTS_REMOTE_PAINT_SERIALIZER_H_
#define COMPONENTS_REMOTE_PAINT_SERIALIZER_H_

#include <cstddef>
#include <string>
#include <vector>

#include "third_party/skia/include/core/SkData.h"
#include "third_party/skia/include/core/SkPicture.h"

namespace remote_paint {

struct FontStats {
  std::string family;
  size_t glyphs = 0;
  size_t original_bytes = 0;
  size_t subset_bytes = 0;
  size_t missing_glyphs = 0;
  size_t glyph_slots = 0;
};

struct AssetRange { size_t offset=0; size_t bytes=0; std::string kind; size_t glyph_slots=0; };

struct SerializedPicture {
  std::vector<AssetRange> asset_ranges;
  bool asset_ranges_complete = false;
  sk_sp<const SkData> bytes;
  std::vector<FontStats> fonts;
  size_t image_bytes = 0;
  size_t image_count = 0;
  size_t bitmap_glyphs = 0;
  bool requires_isolation = false;
  size_t font_cache_hits = 0;
  size_t image_cache_hits = 0;
  size_t font_encoding_shares = 0;
  size_t image_encoding_shares = 0;
  double portable_ms = 0;
  double glyph_collection_ms = 0;
  double serialize_ms = 0;
  double font_ms = 0;
  double image_ms = 0;
  std::string error;
};

// Input must contain immutable software-backed images. No DOM, Layer, canvas or
// GPU-context pointers cross into this function; it may run on a worker thread.
// Every result is a complete independently replayable picture, including fonts.
SerializedPicture SerializePicture(const SkPicture& picture,
                                   size_t byte_budget = 16 * 1024 * 1024,
                                   bool retain_new_images = true);

struct SerializerAssetCacheStats {
  size_t font_bytes, image_bytes, font_entries, image_entries;
  size_t font_evictions, image_evictions, font_pending, image_pending;
  size_t font_encodes, image_encodes, font_shares, image_shares;
  size_t font_bypasses, image_bypasses;
};
// Each domain is sampled under its own lock. Charges describe retained cache
// owners; active serializer/IPC pins and driver/process overhead are separate.
SerializerAssetCacheStats GetSerializerAssetCacheStats();

// Tests reset only idle process-local caches; active jobs are never discarded.
bool ClearSerializerAssetCachesForTesting();

}  // namespace remote_paint
#endif
