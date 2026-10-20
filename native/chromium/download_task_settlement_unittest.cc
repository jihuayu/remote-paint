// Real file jobs, DownloadFileImpl, DownloadItemImpl and actual task runners.
// Fixtures seed real resumable bytes; no network/browser acceptance is implied.
#include <atomic>
#include <memory>
#include <utility>

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/memory/ref_counted.h"
#include "base/run_loop.h"
#include "base/synchronization/waitable_event.h"
#include "base/task/thread_pool.h"
#include "base/test/scoped_command_line.h"
#include "base/test/task_environment.h"
#include "base/threading/thread.h"
#include "base/threading/thread_restrictions.h"
#include "base/time/time.h"
#include "components/download/public/common/download_create_info.h"
#include "components/download/public/common/download_file.h"
#include "components/download/public/common/download_file_impl.h"
#include "components/download/public/common/download_item_impl.h"
#include "components/download/public/common/download_item_impl_delegate.h"
#include "components/download/public/common/download_save_info.h"
#include "components/download/public/common/download_task_runner.h"
#include "components/download/public/common/input_stream.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"

namespace {
using download::DownloadFile;
using download::DownloadFileCleanupState;
using download::DownloadFileImpl;
constexpr auto kNone = download::DOWNLOAD_INTERRUPT_REASON_NONE;

struct Destruction : base::RefCountedThreadSafe<Destruction> {
  Destruction() = default;
  std::atomic<bool> stream_destroyed{false};
  bool hold_destructor = false;
  bool unverified = false;
  base::WaitableEvent entered{base::WaitableEvent::ResetPolicy::MANUAL,
                              base::WaitableEvent::InitialState::NOT_SIGNALED};
  base::WaitableEvent allow{base::WaitableEvent::ResetPolicy::MANUAL,
                            base::WaitableEvent::InitialState::NOT_SIGNALED};
 private:
  friend class base::RefCountedThreadSafe<Destruction>;
  ~Destruction() = default;
};
class ObservedStream : public download::InputStream {
 public:
  explicit ObservedStream(scoped_refptr<Destruction> record) : record_(record) {}
  ~ObservedStream() override { record_->stream_destroyed = true; }
 private:
  scoped_refptr<Destruction> record_;
};
class ObservedFile : public DownloadFileImpl {
 public:
  ObservedFile(std::unique_ptr<download::DownloadSaveInfo> save,
               const base::FilePath& directory, scoped_refptr<Destruction> record)
      : DownloadFileImpl(std::move(save), directory,
                         std::make_unique<ObservedStream>(record),
                         download::DownloadItem::kInvalidId, {}), record_(record) {}
  ~ObservedFile() override {
    record_->entered.Signal();
    if (record_->hold_destructor) {
      base::ScopedAllowBaseSyncPrimitivesForTesting allow_wait;
      record_->allow.Wait();
    }
  }
  bool CancelAndReportDeletion() override {
    if (record_->unverified)
      return DownloadFile::CancelAndReportDeletion();
    return DownloadFileImpl::CancelAndReportDeletion();
  }
 private:
  scoped_refptr<Destruction> record_;
};
class HoldingTargetDelegate : public download::DownloadItemImplDelegate {
 public:
  void DetermineDownloadTarget(download::DownloadItemImpl*,
                               download::DownloadTargetCallback callback) override {
    target_ = std::move(callback);
  }
 private:
  download::DownloadTargetCallback target_;
};
class RemotePaintDownloadTaskTest : public testing::Test {
 protected:
  void SetUp() override { ASSERT_TRUE(directory_.CreateUniqueTempDir()); }
  auto Runner() { return download::GetDownloadTaskRunner(); }
  auto State() { return base::MakeRefCounted<DownloadFileCleanupState>(); }
  base::FilePath Path(const char* name) { return directory_.GetPath().AppendASCII(name); }
  std::unique_ptr<ObservedFile> File(const base::FilePath& path,
                                    scoped_refptr<Destruction> record,
                                    bool initialize = true) {
    EXPECT_TRUE(base::WriteFile(path, "partial"));
    auto save = std::make_unique<download::DownloadSaveInfo>();
    save->file_path = path; save->offset = 7; save->file_offset = 7;
    auto file = std::make_unique<ObservedFile>(std::move(save), directory_.GetPath(), record);
    if (initialize) {
      base::RunLoop loop;
      Runner()->PostTask(FROM_HERE, base::BindOnce(
          [](ObservedFile* file, base::RepeatingClosure quit) {
            file->Initialize(base::BindRepeating(
                [](base::RepeatingClosure quit, download::DownloadInterruptReason reason,
                   int64_t) { EXPECT_EQ(kNone, reason); quit.Run(); }, quit), {}, {});
          }, file.get(), loop.QuitClosure()));
      loop.Run();
    }
    return file;
  }
  auto Info() {
    auto info = std::make_unique<download::DownloadCreateInfo>();
    info->url_chain.emplace_back("https://example.test/file");
    info->save_info = std::make_unique<download::DownloadSaveInfo>();
    return info;
  }
  auto CompletedItem(HoldingTargetDelegate& delegate, const base::FilePath& path) {
    return std::make_unique<download::DownloadItemImpl>(
        &delegate, "11111111-2222-4333-8444-555555555555", 3, path, path,
        std::vector<GURL>{GURL("https://example.test/file")}, GURL(), std::string(),
        GURL(), GURL(), std::nullopt, "application/octet-stream", "application/octet-stream",
        base::Time::Now(), base::Time::Now(), std::string(), std::string(),
        7, 7, 0, std::string(), download::DownloadItem::COMPLETE,
        download::DOWNLOAD_DANGER_TYPE_NOT_DANGEROUS, kNone,
        false, false, false, base::Time(), true,
        std::vector<download::DownloadItem::ReceivedSlice>{}, -1, -1, nullptr);
  }
  base::test::TaskEnvironment tasks_;
  base::test::ScopedCommandLine command_;
  base::ScopedTempDir directory_;
};

TEST_F(RemotePaintDownloadTaskTest, ActualCancelRemovesFileAndDestroysStream) {
  auto record = base::MakeRefCounted<Destruction>();
  const auto path = Path("partial"); auto file = File(path, record); auto state = State();
  state->Cancel(Runner(), std::move(file));
  EXPECT_EQ(1u, state->GetSnapshot().pending);
  tasks_.RunUntilIdle();
  EXPECT_EQ(0u, state->GetSnapshot().pending); EXPECT_FALSE(state->GetSnapshot().failed);
  EXPECT_TRUE(record->stream_destroyed); EXPECT_FALSE(base::PathExists(path));
}

TEST_F(RemotePaintDownloadTaskTest, DestructionMustFinishBeforeSuccessfulSettlement) {
  auto record = base::MakeRefCounted<Destruction>(); record->hold_destructor = true;
  const auto path = Path("partial"); auto file = File(path, record); auto state = State();
  base::ScopedClosureRunner release(base::BindOnce(
      [](scoped_refptr<Destruction> r) { r->allow.Signal(); }, record));
  state->Cancel(Runner(), std::move(file));
  {
    base::ScopedAllowBaseSyncPrimitivesForTesting allow_wait;
    ASSERT_TRUE(record->entered.TimedWait(base::Seconds(10)));
  }
  EXPECT_FALSE(base::PathExists(path)); EXPECT_FALSE(record->stream_destroyed);
  EXPECT_EQ(1u, state->GetSnapshot().pending);
  record->allow.Signal(); tasks_.RunUntilIdle();
  EXPECT_TRUE(record->stream_destroyed); EXPECT_EQ(0u, state->GetSnapshot().pending);
  EXPECT_FALSE(state->GetSnapshot().failed);
}

TEST_F(RemotePaintDownloadTaskTest, ActualWorkerCompletionStillNeedsOriginReply) {
  const auto path = Path("to-delete"); ASSERT_TRUE(base::WriteFile(path, "bytes"));
  auto state = State(); auto ran = base::MakeRefCounted<Destruction>();
  state->DeletePath(Runner(), path);
  Runner()->PostTask(FROM_HERE, base::BindOnce(
      [](scoped_refptr<Destruction> r) { r->entered.Signal(); }, ran));
  {
    base::ScopedAllowBaseSyncPrimitivesForTesting allow_wait;
    ASSERT_TRUE(ran->entered.TimedWait(base::Seconds(10)));
  }
  EXPECT_FALSE(base::PathExists(path)); EXPECT_EQ(1u, state->GetSnapshot().pending);
  tasks_.RunUntilIdle(); EXPECT_EQ(0u, state->GetSnapshot().pending);
  EXPECT_FALSE(state->GetSnapshot().failed);
}

TEST_F(RemotePaintDownloadTaskTest, ActualFailureLatchesAcrossLaterSuccess) {
  const auto failed = Path("directory"); ASSERT_TRUE(base::CreateDirectory(failed));
  const auto child = failed.AppendASCII("keep"); ASSERT_TRUE(base::WriteFile(child, "keep"));
  const auto good = Path("good"); ASSERT_TRUE(base::WriteFile(good, "delete"));
  auto state = State(); bool failed_result = true, good_result = false;
  state->DeletePath(Runner(), failed, base::BindOnce([](bool* out, bool v) { *out = v; }, &failed_result));
  state->DeletePath(Runner(), good, base::BindOnce([](bool* out, bool v) { *out = v; }, &good_result));
  EXPECT_EQ(2u, state->GetSnapshot().pending); tasks_.RunUntilIdle();
  EXPECT_FALSE(failed_result); EXPECT_TRUE(good_result); EXPECT_TRUE(state->GetSnapshot().failed);
  EXPECT_EQ(0u, state->GetSnapshot().pending); EXPECT_TRUE(base::PathExists(child));
  EXPECT_FALSE(base::PathExists(good));
}

TEST_F(RemotePaintDownloadTaskTest, EmptyDirectorySkipCannotBecomeDeletionReceipt) {
  const auto path = Path("empty-directory"); ASSERT_TRUE(base::CreateDirectory(path));
  auto state = State(); state->DeletePath(Runner(), path); tasks_.RunUntilIdle();
  EXPECT_TRUE(state->GetSnapshot().failed); EXPECT_TRUE(base::DirectoryExists(path));
}

TEST_F(RemotePaintDownloadTaskTest, RealStoppedRunnerRejectsWithoutDeletingPath) {
  base::Thread thread("stopped-download"); ASSERT_TRUE(thread.Start());
  auto runner = thread.task_runner(); thread.Stop();
  const auto path = Path("retained"); ASSERT_TRUE(base::WriteFile(path, "retained"));
  auto state = State(); bool reported = true;
  state->DeletePath(runner, path, base::BindOnce([](bool* out, bool v) { *out = v; }, &reported));
  EXPECT_FALSE(reported); EXPECT_TRUE(state->GetSnapshot().failed);
  EXPECT_EQ(0u, state->GetSnapshot().pending); EXPECT_TRUE(base::PathExists(path));
}

TEST_F(RemotePaintDownloadTaskTest, UnsupportedCancellationCannotFabricateSuccess) {
  auto record = base::MakeRefCounted<Destruction>(); record->unverified = true;
  const auto path = Path("unverified"); auto file = File(path, record); auto state = State();
  state->Cancel(Runner(), std::move(file)); tasks_.RunUntilIdle();
  EXPECT_EQ(0u, state->GetSnapshot().pending); EXPECT_TRUE(state->GetSnapshot().failed);
  EXPECT_TRUE(record->stream_destroyed); EXPECT_FALSE(base::PathExists(path));
}

TEST_F(RemotePaintDownloadTaskTest, DetachSettlesOwnerAndPreservesResumablePath) {
  auto record = base::MakeRefCounted<Destruction>(); const auto path = Path("resumable");
  auto file = File(path, record); auto state = State(); state->Detach(Runner(), std::move(file));
  tasks_.RunUntilIdle(); EXPECT_EQ(0u, state->GetSnapshot().pending);
  EXPECT_FALSE(state->GetSnapshot().failed); EXPECT_TRUE(record->stream_destroyed);
  EXPECT_EQ(7, base::GetFileSize(path).value_or(-1));
}

TEST_F(RemotePaintDownloadTaskTest, NativeItemHandleSurvivesActualRemovalAndFileJob) {
  command_.GetProcessCommandLine()->AppendSwitch("remote-paint-token");
  HoldingTargetDelegate delegate; auto info = Info();
  auto item = std::make_unique<download::DownloadItemImpl>(&delegate, 1, *info);
  auto state = item->GetRemotePaintFileCleanupState(); ASSERT_TRUE(state);
  auto record = base::MakeRefCounted<Destruction>(); const auto path = Path("item");
  auto file = File(path, record, false);
  item->Start(std::move(file), base::DoNothing(), *info,
              download::URLLoaderFactoryProvider::GetNullPtr());
  item->Remove(); item.reset();
  EXPECT_EQ(1u, state->GetSnapshot().pending);
  tasks_.RunUntilIdle(); EXPECT_EQ(0u, state->GetSnapshot().pending);
  EXPECT_FALSE(state->GetSnapshot().failed); EXPECT_TRUE(record->stream_destroyed);
  EXPECT_FALSE(base::PathExists(path));
}

TEST_F(RemotePaintDownloadTaskTest, NativeItemKeepsRealCancellationFailureAfterRemoval) {
  command_.GetProcessCommandLine()->AppendSwitch("remote-paint-token");
  HoldingTargetDelegate delegate; auto info = Info();
  auto item = std::make_unique<download::DownloadItemImpl>(&delegate, 4, *info);
  auto state = item->GetRemotePaintFileCleanupState();
  auto record = base::MakeRefCounted<Destruction>(); const auto path = Path("item-failure");
  item->Start(File(path, record, false), base::DoNothing(), *info,
              download::URLLoaderFactoryProvider::GetNullPtr());
  tasks_.RunUntilIdle();
  ASSERT_TRUE(base::Move(path, Path("moved-original")));
  ASSERT_TRUE(base::CreateDirectory(path));
  const auto child = path.AppendASCII("keep"); ASSERT_TRUE(base::WriteFile(child, "keep"));
  item->Remove(); item.reset(); tasks_.RunUntilIdle();
  EXPECT_EQ(0u, state->GetSnapshot().pending); EXPECT_TRUE(state->GetSnapshot().failed);
  EXPECT_TRUE(record->stream_destroyed); EXPECT_TRUE(base::PathExists(child));
}

TEST_F(RemotePaintDownloadTaskTest, CompletedItemDoesNotTrustExternallyRemovedFlag) {
  command_.GetProcessCommandLine()->AppendSwitch("remote-paint-token");
  HoldingTargetDelegate delegate; const auto path = Path("completed");
  ASSERT_TRUE(base::WriteFile(path, "partial")); auto item = CompletedItem(delegate, path);
  item->OnDownloadedFileRemoved();
  auto state = item->GetRemotePaintFileCleanupState(); bool called = false, removed = false;
  item->DeleteFile(base::BindOnce([](bool* called, bool* removed, bool v) {
    *called = true; *removed = v;
  }, &called, &removed));
  EXPECT_FALSE(called); EXPECT_EQ(1u, state->GetSnapshot().pending);
  item.reset(); tasks_.RunUntilIdle();
  EXPECT_TRUE(called); EXPECT_TRUE(removed); EXPECT_FALSE(base::PathExists(path));
  EXPECT_EQ(0u, state->GetSnapshot().pending); EXPECT_FALSE(state->GetSnapshot().failed);
}

TEST_F(RemotePaintDownloadTaskTest, CompletedItemDirectoryIsActualFailure) {
  command_.GetProcessCommandLine()->AppendSwitch("remote-paint-token");
  HoldingTargetDelegate delegate; const auto path = Path("completed-directory");
  ASSERT_TRUE(base::CreateDirectory(path)); auto item = CompletedItem(delegate, path);
  auto state = item->GetRemotePaintFileCleanupState(); bool called = false, removed = true;
  item->DeleteFile(base::BindOnce([](bool* called, bool* removed, bool v) {
    *called = true; *removed = v;
  }, &called, &removed));
  tasks_.RunUntilIdle(); EXPECT_TRUE(called); EXPECT_FALSE(removed);
  EXPECT_EQ(0u, state->GetSnapshot().pending); EXPECT_TRUE(state->GetSnapshot().failed);
  EXPECT_TRUE(base::DirectoryExists(path));
}

TEST_F(RemotePaintDownloadTaskTest, NonNativeItemHasNoNativeTrackingState) {
  command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-token");
  HoldingTargetDelegate delegate; auto info = Info();
  auto item = std::make_unique<download::DownloadItemImpl>(&delegate, 2, *info);
  EXPECT_FALSE(item->GetRemotePaintFileCleanupState());
}
}  // namespace
