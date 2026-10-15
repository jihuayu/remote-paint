#ifndef COMPONENTS_REMOTE_PAINT_FONT_SUBSET_H_
#define COMPONENTS_REMOTE_PAINT_FONT_SUBSET_H_
#include <set>
#include <string>
#include "third_party/skia/include/core/SkData.h"
#include "third_party/skia/include/core/SkFontMgr.h"
#include "third_party/skia/include/core/SkTypeface.h"
namespace remote_paint {
sk_sp<SkFontMgr> FontManager();
sk_sp<SkData> SubsetTypeface(SkTypeface* typeface, const std::set<SkGlyphID>& glyphs, std::string* error = nullptr);
}
#endif
