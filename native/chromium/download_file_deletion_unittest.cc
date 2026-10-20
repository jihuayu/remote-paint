// These contracts use the real BaseFile and filesystem, including a real
// deletion failure. The result only describes this owner's close/path removal.
#include "components/download/public/common/base_file.h"

#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include "base/containers/span.h"
#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "build/build_config.h"
#include "components/download/public/common/download_item.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace {
class RemotePaintDownloadDeletionTest : public testing::Test {
 protected:
  void SetUp() override { ASSERT_TRUE(directory_.CreateUniqueTempDir()); }
  std::unique_ptr<download::BaseFile> File() {
    return std::make_unique<download::BaseFile>(download::DownloadItem::kInvalidId);
  }
  auto Initialize(download::BaseFile& file) {
    return file.Initialize({}, directory_.GetPath(), base::File(), 0,
                           std::string(), std::nullopt, false, &wasted_);
  }
  auto Append(download::BaseFile& file, std::string_view bytes) {
    return file.AppendDataToFile(base::as_byte_span(bytes));
  }
  base::ScopedTempDir directory_;
  int64_t wasted_ = 0;
};
constexpr auto kNone = download::DOWNLOAD_INTERRUPT_REASON_NONE;

TEST_F(RemotePaintDownloadDeletionTest, NoInitializedPathHasNothingToDelete) {
  auto file = File();
  EXPECT_TRUE(file->full_path().empty());
  EXPECT_TRUE(file->CancelAndReportDeletion());
  EXPECT_FALSE(file->in_progress());
}

TEST_F(RemotePaintDownloadDeletionTest, RemovesActualEmptyFile) {
  auto file = File();
  ASSERT_EQ(kNone, Initialize(*file));
  const auto path = file->full_path();
  ASSERT_TRUE(base::PathExists(path));
  EXPECT_TRUE(file->CancelAndReportDeletion());
  EXPECT_FALSE(file->in_progress());
  EXPECT_FALSE(base::PathExists(path));
}

TEST_F(RemotePaintDownloadDeletionTest, ClosesAndRemovesWrittenPartialFile) {
  auto file = File();
  ASSERT_EQ(kNone, Initialize(*file));
  ASSERT_EQ(kNone, Append(*file, "partial bytes"));
  const auto path = file->full_path();
  ASSERT_EQ(13, base::GetFileSize(path).value_or(-1));
  ASSERT_TRUE(file->in_progress());
  EXPECT_TRUE(file->CancelAndReportDeletion());
  EXPECT_FALSE(file->in_progress());
  EXPECT_FALSE(base::PathExists(path));
}

TEST_F(RemotePaintDownloadDeletionTest, RemovesAlreadyFinishedFile) {
  auto file = File();
  ASSERT_EQ(kNone, Initialize(*file));
  ASSERT_EQ(kNone, Append(*file, "finished"));
  const auto path = file->full_path();
  (void)file->Finish();
  ASSERT_FALSE(file->in_progress());
  ASSERT_TRUE(base::PathExists(path));
  EXPECT_TRUE(file->CancelAndReportDeletion());
  EXPECT_FALSE(base::PathExists(path));
}

#if BUILDFLAG(IS_POSIX)
TEST_F(RemotePaintDownloadDeletionTest, AlreadyUnlinkedFileReportsSuccess) {
  auto file = File();
  ASSERT_EQ(kNone, Initialize(*file));
  ASSERT_EQ(kNone, Append(*file, "partial"));
  const auto path = file->full_path();
  ASSERT_TRUE(base::DeleteFile(path));
  ASSERT_TRUE(file->in_progress());
  EXPECT_TRUE(file->CancelAndReportDeletion());
  EXPECT_FALSE(file->in_progress());
  EXPECT_FALSE(base::PathExists(path));
}

TEST_F(RemotePaintDownloadDeletionTest, RealDeletionFailureDoesNotReportSuccess) {
  auto file = File();
  ASSERT_EQ(kNone, Initialize(*file));
  ASSERT_EQ(kNone, Append(*file, "owned bytes"));
  const auto path = file->full_path();
  const auto moved = directory_.GetPath().AppendASCII("moved-original");
  ASSERT_TRUE(base::Move(path, moved));
  ASSERT_TRUE(base::CreateDirectory(path));
  const auto child = path.AppendASCII("do-not-recursively-delete");
  ASSERT_TRUE(base::WriteFile(child, "keep"));
  ASSERT_TRUE(file->in_progress());
  // DeleteFile fails on an actual nonempty directory, even when run as root.
  EXPECT_FALSE(file->CancelAndReportDeletion());
  EXPECT_FALSE(file->in_progress());
  EXPECT_TRUE(base::PathExists(child));
  EXPECT_EQ(11, base::GetFileSize(moved).value_or(-1));
  // Cancel's historical detach behavior is preserved even on deletion failure.
  file.reset();
  EXPECT_TRUE(base::PathExists(child));
  EXPECT_TRUE(base::PathExists(moved));
}

TEST_F(RemotePaintDownloadDeletionTest, OtherOpenHandlesAreOutsideDeletionResult) {
  auto file = File();
  ASSERT_EQ(kNone, Initialize(*file));
  ASSERT_EQ(kNone, Append(*file, "partial"));
  const auto path = file->full_path();
  base::File other(path, base::File::FLAG_OPEN | base::File::FLAG_READ);
  ASSERT_TRUE(other.IsValid());
  EXPECT_TRUE(file->CancelAndReportDeletion());
  EXPECT_FALSE(file->in_progress());
  EXPECT_FALSE(base::PathExists(path));
  // A successful unlink is not proof that another owner's inode/handle retired.
  EXPECT_TRUE(other.IsValid());
  EXPECT_EQ(7, other.GetLength());
}
#endif  // BUILDFLAG(IS_POSIX)
}  // namespace
