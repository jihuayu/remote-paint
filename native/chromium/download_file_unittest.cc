// Native file-extent admission tests exercise real BaseFile and filesystem IO.
#include "components/download/public/common/base_file.h"

#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include "base/command_line.h"
#include "base/containers/span.h"
#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/test/scoped_command_line.h"
#include "components/download/public/common/download_item.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace {
using download::BaseFile;
constexpr int64_t kCap = 4 * 1024 * 1024;
constexpr auto kNone = download::DOWNLOAD_INTERRUPT_REASON_NONE;
constexpr auto kLimit = download::DOWNLOAD_INTERRUPT_REASON_FILE_TOO_LARGE;

class RemotePaintDownloadWriteTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_TRUE(directory_.CreateUniqueTempDir());
    command_.GetProcessCommandLine()->AppendSwitchASCII("remote-paint-token",
                                                       std::string(64, 'a'));
  }
  auto File() {
    return std::make_unique<BaseFile>(download::DownloadItem::kInvalidId);
  }
  auto Initialize(BaseFile& file, bool sparse = false,
                  const base::FilePath& path = {}, int64_t cursor = 0) {
    return file.Initialize(path, directory_.GetPath(), base::File(), cursor,
                           std::string(), std::nullopt, sparse, &wasted_);
  }
  auto Append(BaseFile& file, std::string_view bytes) {
    return file.AppendDataToFile(base::as_byte_span(bytes));
  }
  auto Write(BaseFile& file, int64_t offset, std::string_view bytes) {
    return file.WriteDataToFile(offset, base::as_byte_span(bytes));
  }
  int64_t Size(const base::FilePath& path) {
    return base::GetFileSize(path).value_or(-1);
  }
  std::string Contents(const base::FilePath& path) {
    std::string bytes;
    EXPECT_TRUE(base::ReadFileToString(path, &bytes));
    return bytes;
  }
  base::FilePath Existing(std::string_view bytes) {
    const auto path = directory_.GetPath().AppendASCII("resume.bin");
    EXPECT_TRUE(base::WriteFile(path, bytes));
    return path;
  }
  base::test::ScopedCommandLine command_;
  base::ScopedTempDir directory_;
  int64_t wasted_ = 0;
};

TEST_F(RemotePaintDownloadWriteTest, EmptyAndExactLimitRemainValid) {
  auto file = File();
  ASSERT_EQ(kNone, Initialize(*file));
  EXPECT_EQ(kNone, Append(*file, ""));
  EXPECT_EQ(0, Size(file->full_path()));
  const std::string exact(kCap, 'x');
  ASSERT_EQ(kNone, Append(*file, exact));
  EXPECT_EQ(kCap, Size(file->full_path()));
  EXPECT_EQ(kCap, file->bytes_so_far());
  EXPECT_EQ(kLimit, Append(*file, "y"));
  EXPECT_EQ(kCap, Size(file->full_path()));
  EXPECT_EQ(kCap, file->bytes_so_far());
  EXPECT_EQ(exact, Contents(file->full_path()));
}

TEST_F(RemotePaintDownloadWriteTest, RejectedWriteHasNoPermittedPrefix) {
  auto file = File();
  ASSERT_EQ(kNone, Initialize(*file));
  EXPECT_EQ(kLimit, Append(*file, std::string(kCap + 1, 'x')));
  EXPECT_EQ(0, Size(file->full_path()));
  EXPECT_EQ(0, file->bytes_so_far());
  EXPECT_EQ(kNone, Append(*file, "a"));
  EXPECT_EQ("a", Contents(file->full_path()));
}

TEST_F(RemotePaintDownloadWriteTest, SparseWritesAndIntegerEdgesUseFileExtent) {
  auto file = File();
  ASSERT_EQ(kNone, Initialize(*file, true));
  ASSERT_EQ(kNone, Write(*file, kCap - 1, "x"));
  EXPECT_EQ(kCap, Size(file->full_path()));
  EXPECT_EQ(kNone, Write(*file, 0, "ab"));
  const auto count = file->bytes_so_far();
  EXPECT_EQ(kLimit, Write(*file, kCap, "x"));
  EXPECT_EQ(kLimit, Write(*file, kCap - 1, "xx"));
  EXPECT_EQ(kLimit, Write(*file, std::numeric_limits<int64_t>::max(), "x"));
  EXPECT_EQ(kLimit, Write(*file, -1, "x"));
  EXPECT_EQ(kLimit, Write(*file, -1, ""));
  EXPECT_EQ(kLimit, Write(*file, kCap + 1, ""));
  EXPECT_EQ(kNone, Write(*file, kCap, ""));
  EXPECT_EQ(count, file->bytes_so_far());
  EXPECT_EQ(kCap, Size(file->full_path()));
  const auto bytes = Contents(file->full_path());
  ASSERT_EQ(kCap, static_cast<int64_t>(bytes.size()));
  EXPECT_EQ('a', bytes[0]);
  EXPECT_EQ('b', bytes[1]);
  EXPECT_EQ('x', bytes.back());
}

TEST_F(RemotePaintDownloadWriteTest, OversizedResumeIsRejectedBeforeTruncation) {
  const auto path = Existing(std::string(kCap + 1, 'x'));
  auto file = File();
  EXPECT_EQ(kLimit, Initialize(*file, false, path, 16));
  EXPECT_FALSE(file->in_progress());
  EXPECT_EQ(kCap + 1, Size(path));
  EXPECT_EQ(kCap + 1, wasted_);
  file.reset();
  EXPECT_FALSE(base::PathExists(path));
}

TEST_F(RemotePaintDownloadWriteTest, InvalidResumeCursorCannotWidenOrTruncate) {
  for (int64_t cursor : {int64_t{-1}, kCap + 1, std::numeric_limits<int64_t>::max()}) {
    const auto path = Existing("original");
    auto file = File();
    EXPECT_EQ(kLimit, Initialize(*file, true, path, cursor));
    EXPECT_FALSE(file->in_progress());
    EXPECT_EQ("original", Contents(path));
    file.reset();
    EXPECT_FALSE(base::PathExists(path));
  }
}

TEST_F(RemotePaintDownloadWriteTest, ExactSparseResumeStillRejectsNextByte) {
  const auto path = Existing(std::string(kCap, 'x'));
  auto file = File();
  ASSERT_EQ(kNone, Initialize(*file, true, path, kCap));
  EXPECT_EQ(kLimit, Write(*file, kCap, "y"));
  EXPECT_EQ(kCap, Size(path));
  EXPECT_EQ(kCap, file->bytes_so_far());
}

TEST_F(RemotePaintDownloadWriteTest, RemovingSwitchCannotWidenConstructedOwner) {
  auto file = File();
  command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-token");
  ASSERT_EQ(kNone, Initialize(*file));
  EXPECT_EQ(kLimit, Append(*file, std::string(kCap + 1, 'x')));
  EXPECT_EQ(0, Size(file->full_path()));
}

TEST_F(RemotePaintDownloadWriteTest, NativeFlagCannotDisableBudgetWithBadValue) {
  for (std::string_view token : {"", "invalid-token"}) {
    command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-token");
    command_.GetProcessCommandLine()->AppendSwitchASCII("remote-paint-token",
                                                       token);
    auto file = File();
    ASSERT_EQ(kNone, Initialize(*file));
    EXPECT_EQ(kLimit, Append(*file, std::string(kCap + 1, 'x')));
    EXPECT_EQ(0, Size(file->full_path()));
  }
}

TEST_F(RemotePaintDownloadWriteTest, NonNativeDownloadKeepsOriginalBehavior) {
  command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-token");
  auto file = File();
  command_.GetProcessCommandLine()->AppendSwitchASCII("remote-paint-token", "x");
  ASSERT_EQ(kNone, Initialize(*file));
  EXPECT_EQ(kNone, Append(*file, std::string(kCap + 1, 'x')));
  EXPECT_EQ(kCap + 1, Size(file->full_path()));
  EXPECT_EQ(kCap + 1, file->bytes_so_far());
}

TEST_F(RemotePaintDownloadWriteTest, CancelRemovesAcceptedPrefixAfterLimitError) {
  auto file = File();
  ASSERT_EQ(kNone, Initialize(*file));
  const auto path = file->full_path();
  ASSERT_EQ(kNone, Append(*file, "accepted"));
  EXPECT_EQ(kLimit, Write(*file, kCap - 1, "xx"));
  EXPECT_EQ("accepted", Contents(path));
  file->Cancel();
  EXPECT_FALSE(file->in_progress());
  EXPECT_FALSE(base::PathExists(path));
}
}  // namespace
