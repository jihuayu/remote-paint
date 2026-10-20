// Managed-download component contracts: actual items, files, task ownership and
// allocation rejection. Mock time is used only for the documented TTL timers.
#include <atomic>
#include <map>
#include <memory>
#include <utility>
#include <vector>

#include "base/command_line.h"
#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/memory/raw_ref.h"
#include "base/memory/weak_ptr.h"
#include "base/process/launch.h"
#include "base/process/process.h"
#include "base/synchronization/waitable_event.h"
#include "base/test/scoped_command_line.h"
#include "base/test/task_environment.h"
#include "base/threading/thread_restrictions.h"
#include "components/download/public/common/base_file.h"
#include "components/download/public/common/download_create_info.h"
#include "components/download/public/common/download_file.h"
#include "components/download/public/common/download_item_impl.h"
#include "components/download/public/common/download_item_impl_delegate.h"
#include "components/download/public/common/download_target_info.h"
#include "components/download/public/common/download_task_runner.h"
#include "components/download/public/common/in_progress_download_manager.h"
#include "components/download/public/common/input_stream.h"
#include "components/download/public/common/native_download_budget.h"
#include "components/download/public/common/url_download_handler.h"
#include "net/base/io_buffer.h"
#include "testing/gtest/include/gtest/gtest.h"

#if BUILDFLAG(IS_POSIX)
#include <sys/stat.h>
#endif

namespace {
using Budget = download::NativeDownloadBudget;
using Lease = download::NativeDownloadLease;
using Item = download::DownloadItemImpl;
using Manager = download::InProgressDownloadManager;
using Handler = download::UrlDownloadHandler;
using Request = download::UrlDownloadHandlerCleanupState;
using Phase = Request::Phase;
constexpr auto kNone = download::DOWNLOAD_INTERRUPT_REASON_NONE;
struct Reads : base::RefCountedThreadSafe<Reads> {
  std::atomic<int> count{0};
 private:
  friend class base::RefCountedThreadSafe<Reads>;
  ~Reads() = default;
};
struct BarrierEvent : base::RefCountedThreadSafe<BarrierEvent> {
  base::WaitableEvent data{base::WaitableEvent::ResetPolicy::MANUAL,
                           base::WaitableEvent::InitialState::NOT_SIGNALED};
 private:
  friend class base::RefCountedThreadSafe<BarrierEvent>;
  ~BarrierEvent() = default;
};
class Bytes : public download::InputStream {
 public:
  Bytes(scoped_refptr<Reads> reads, bool finish, size_t bytes)
      : reads_(reads), finish_(finish), bytes_(bytes, 'x') {}
  bool IsEmpty() override { return false; }
  StreamState Read(scoped_refptr<net::IOBuffer>* data, size_t* length) override {
    ++reads_->count;
    if (!finish_) return EMPTY;
    if (!sent_ && !bytes_.empty()) {
      *data = base::MakeRefCounted<net::StringIOBuffer>(bytes_);
      *length = bytes_.size(); sent_ = true; return HAS_DATA;
    }
    return COMPLETE;
  }
 private:
  scoped_refptr<Reads> reads_;
  const bool finish_;
  const std::string bytes_;
  bool sent_ = false;
};
class Items : public Manager::Delegate, public download::DownloadItemImplDelegate {
 public:
  struct Pending {
    std::unique_ptr<download::DownloadCreateInfo> info;
    download::DownloadUrlParameters::OnStartedCallback started;
    Manager::StartDownloadItemCallback callback;
  };
  base::FilePath root;
  std::map<uint32_t, std::unique_ptr<Item>> items;
  std::vector<Pending> pending;
  std::vector<scoped_refptr<Lease>> metadata_acks;
  int allocations = 0;
  bool hold_creation = false;
  bool hold_metadata = false;
  base::FilePath duplicate;
  base::FilePath GetDefaultDownloadDirectory() override { return root; }
  void StartDownloadItem(std::unique_ptr<download::DownloadCreateInfo> info,
      download::DownloadUrlParameters::OnStartedCallback started,
      Manager::StartDownloadItemCallback callback) override {
    Pending p{std::move(info), std::move(started), std::move(callback)};
    if (hold_creation) { pending.push_back(std::move(p)); return; }
    Create(std::move(p));
  }
  void Create(Pending p) {
    Item* item = nullptr;
    if (p.info->is_new_download) {
      const auto id = ++allocations;
      auto owned = std::make_unique<Item>(this, id, *p.info);
      item = owned.get(); items[id] = std::move(owned);
    } else {
      for (auto& [id, owned] : items)
        if (owned->GetGuid() == p.info->guid) item = owned.get();
    }
    std::move(p.callback).Run(std::move(p.info), item, duplicate, false);
    if (p.started) std::move(p.started).Run(item, item ? kNone : download::DOWNLOAD_INTERRUPT_REASON_USER_CANCELED);
  }
  void RejectPending() {
    for (auto& p : pending)
      std::move(p.callback).Run(std::move(p.info), nullptr, {}, false);
    pending.clear();
  }
  void DetermineDownloadTarget(Item* item, download::DownloadTargetCallback cb) override {
    download::DownloadTargetInfo target;
    target.target_path = root.AppendASCII(item->GetGuid() + ".bin");
    target.intermediate_path = root.AppendASCII(item->GetGuid() + ".part");
    std::move(cb).Run(std::move(target));
  }
  bool ShouldCompleteDownload(Item*, base::OnceClosure) override { return true; }
  bool ShouldOpenDownload(Item*, ShouldOpenDownloadCallback) override { return true; }
  bool IsOffTheRecord() const override { return true; }
  void DownloadRemoved(Item* item) override {
    auto lease = item->GetRemotePaintAdmission();
    items.erase(item->GetId());  // Actual object/map erasure precedes ACK.
    if (hold_metadata) metadata_acks.push_back(std::move(lease));
    else if (lease) lease->MetadataRetired();
  }
};
class Model {
 public:
  Model(base::test::TaskEnvironment& tasks, bool standalone = false) : tasks_(tasks), standalone_(standalone) {
    EXPECT_TRUE(directory.CreateUniqueTempDir()); delegate.root = directory.GetPath();
    auto secure = base::BindRepeating([](const GURL&) { return true; });
    manager = std::make_unique<Manager>(standalone ? nullptr : &delegate, base::FilePath(), nullptr,
        secure, base::BindRepeating([](int, const GURL&) { return true; }), base::NullCallback());
  }
  ~Model() {
    delegate.RejectPending(); hold_requests = false; CompleteRequests();
    manager.reset(); Drain();
    // On any unexpected failure the global reservation deliberately stays held.
    for (auto& [id, item] : delegate.items) item->Cancel(true);
    delegate.items.clear(); Drain();
  }
  scoped_refptr<Reads> Start(bool finish = false, size_t bytes = 7,
                             bool tracked = true) {
    auto owner = Handler::UniqueUrlDownloadHandlerPtr(new Handler,
        base::OnTaskRunnerDeleter(download::GetIOTaskRunner()));
    auto request = owner->GetRemotePaintRequestCleanupState();
    const auto id = reinterpret_cast<download::UrlDownloadHandlerID>(owner.get());
    static_cast<Handler::Delegate*>(manager.get())->OnUrlDownloadHandlerCreated(std::move(owner));
    requests.emplace_back(id, request);
    auto info = std::make_unique<download::DownloadCreateInfo>();
    info->is_new_download = true; info->result = kNone;
    info->url_chain.emplace_back("https://example.test/file");
    info->save_info = std::make_unique<download::DownloadSaveInfo>();
    if (standalone_) info->save_info->file_path = directory.GetPath().AppendASCII("standalone.bin");
    if (tracked) info->remote_paint_request_cleanup = request;
    auto reads = base::MakeRefCounted<Reads>();
    manager->StartDownload(std::move(info), std::make_unique<Bytes>(reads, finish, bytes),
        download::URLLoaderFactoryProvider::GetNullPtr(), base::BindOnce(
          &Model::Stop, weak.GetWeakPtr(), id), base::BindOnce(
          [](base::WeakPtr<Model> self, download::DownloadItem*, download::DownloadInterruptReason reason) {
            if (self) self->last_started_reason = reason;
          }, weak.GetWeakPtr()));
    return reads;
  }
  void Stop(download::UrlDownloadHandlerID id, bool) {
    if (manager && !hold_requests)
      static_cast<Handler::Delegate*>(manager.get())->OnUrlDownloadStopped(id);
  }
  void CompleteRequests() {
    if (!manager) return;
    for (auto& [id, state] : requests)
      if (state->GetPhase() == Phase::Active)
        static_cast<Handler::Delegate*>(manager.get())->OnUrlDownloadStopped(id);
  }
  void Barrier() {
    auto event = base::MakeRefCounted<BarrierEvent>();
    download::GetIOTaskRunner()->PostTask(FROM_HERE, base::BindOnce(
        [](decltype(event) event) { event->data.Signal(); }, event));
    base::ScopedAllowBaseSyncPrimitivesForTesting allow_wait;
    EXPECT_TRUE(event->data.TimedWait(base::Seconds(10)));
  }
  void Drain() {
    for (int i = 0; i < 6; ++i) {
      tasks_->RunUntilIdle(); Barrier(); tasks_->RunUntilIdle();
      tasks_->FastForwardBy(base::Milliseconds(50));
    }
  }
  void RetireAll() {
    std::vector<scoped_refptr<Lease>> leases;
    for (auto& [id, item] : delegate.items) leases.push_back(item->GetRemotePaintAdmission());
    for (auto& lease : leases) lease->BeginRetire();
    Drain();
  }
  base::ScopedTempDir directory;
  Items delegate;
  std::unique_ptr<Manager> manager;
  std::vector<std::pair<download::UrlDownloadHandlerID, scoped_refptr<Request>>> requests;
  bool hold_requests = false;
  download::DownloadInterruptReason last_started_reason = kNone;
 private:
  raw_ref<base::test::TaskEnvironment> tasks_;
  const bool standalone_;
 public:
  base::WeakPtrFactory<Model> weak{this};
};
class RemotePaintDownloadBudgetTest : public testing::Test {
 protected:
  void SetUp() override {
    command_.GetProcessCommandLine()->AppendSwitch("remote-paint-token");
    command_.GetProcessCommandLine()->AppendSwitch("remote-paint-download-budget-v1");
  }
  base::test::TaskEnvironment tasks_{base::test::TaskEnvironment::TimeSource::MOCK_TIME};
  base::test::ScopedCommandLine command_;
};

TEST_F(RemotePaintDownloadBudgetTest, FifthDownloadRejectedBeforeItemAndStreamRead) {
  Model model(tasks_);
  for (int i = 0; i < 4; ++i) model.Start();
  auto fifth = model.Start(); model.Drain();
  EXPECT_EQ(4, model.delegate.allocations); EXPECT_EQ(4u, model.delegate.items.size());
  EXPECT_EQ(0, fifth->count); EXPECT_EQ(download::DOWNLOAD_INTERRUPT_REASON_FILE_BLOCKED, model.last_started_reason);
  EXPECT_EQ(4u, Budget::ReservedItems()); EXPECT_EQ(16u * 1024 * 1024, Budget::ReservedBytes());
  EXPECT_EQ(4u, model.manager->NativeDownloadRecordCountForTesting());
  model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
  EXPECT_TRUE(base::IsDirectoryEmpty(model.directory.GetPath()));
}

TEST_F(RemotePaintDownloadBudgetTest, TerminalCleanupReusesQuotaForTwelveRealDownloads) {
  Model model(tasks_);
  for (int i = 0; i < 12; ++i) {
    model.Start(true); model.Drain();
    ASSERT_EQ(1u, model.delegate.items.size());
    EXPECT_EQ(download::DownloadItem::COMPLETE, model.delegate.items.begin()->second->GetState());
    tasks_.FastForwardBy(base::Seconds(31)); model.Drain();
    EXPECT_EQ(0u, Budget::ReservedItems()); EXPECT_TRUE(model.delegate.items.empty());
    EXPECT_EQ(0u, model.manager->NativeDownloadRecordCountForTesting());
    EXPECT_TRUE(base::IsDirectoryEmpty(model.directory.GetPath()));
  }
  EXPECT_EQ(12, model.delegate.allocations);
}

TEST_F(RemotePaintDownloadBudgetTest, FileCleanupAloneCannotReleaseUrlOwner) {
  Model model(tasks_); model.hold_requests = true; model.Start(); model.Drain();
  model.RetireAll(); EXPECT_EQ(1u, Budget::ReservedItems());
  EXPECT_TRUE(base::IsDirectoryEmpty(model.directory.GetPath()));
  model.hold_requests = false; model.CompleteRequests(); model.Drain();
  EXPECT_EQ(0u, Budget::ReservedItems()); EXPECT_TRUE(model.delegate.items.empty());
}

TEST_F(RemotePaintDownloadBudgetTest, DestructionAndEmptyItemMapStillNeedOwnerMetadataAck) {
  Model model(tasks_); model.delegate.hold_metadata = true; model.Start(); model.Drain();
  model.RetireAll(); EXPECT_TRUE(model.delegate.items.empty());
  ASSERT_EQ(1u, model.delegate.metadata_acks.size()); EXPECT_EQ(1u, Budget::ReservedItems());
  model.delegate.metadata_acks.front()->MetadataRetired(); model.Drain();
  EXPECT_EQ(0u, Budget::ReservedItems());
}

TEST_F(RemotePaintDownloadBudgetTest, ExpiredCreatorDoesNotInventAllocationSettlement) {
  Model model(tasks_); model.delegate.hold_creation = true; auto reads = model.Start();
  tasks_.FastForwardBy(base::Minutes(6)); model.Drain();
  EXPECT_EQ(0, model.delegate.allocations); EXPECT_EQ(0, reads->count);
  EXPECT_EQ(1u, Budget::ReservedItems());
  model.delegate.RejectPending(); model.Drain(); EXPECT_EQ(0u, Budget::ReservedItems());
}

TEST_F(RemotePaintDownloadBudgetTest, CapacityIsSharedByTwoManagers) {
  Model a(tasks_), b(tasks_); a.Start(); a.Start(); b.Start(); b.Start();
  auto fifth = b.Start(); a.Drain(); b.Drain();
  EXPECT_EQ(2, a.delegate.allocations); EXPECT_EQ(2, b.delegate.allocations);
  EXPECT_EQ(0, fifth->count); EXPECT_EQ(4u, Budget::ReservedItems());
  a.RetireAll(); b.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}

TEST_F(RemotePaintDownloadBudgetTest, ActiveDeadlineCancelsActualOpenFilesAndRecovers) {
  Model model(tasks_); model.Start(); model.Drain();
  ASSERT_EQ(1u, Budget::ReservedItems());
  tasks_.FastForwardBy(base::Minutes(6)); model.Drain();
  EXPECT_EQ(0u, Budget::ReservedItems()); EXPECT_TRUE(model.delegate.items.empty());
  EXPECT_TRUE(base::IsDirectoryEmpty(model.directory.GetPath()));
  model.Start(true); model.Drain(); model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}

TEST_F(RemotePaintDownloadBudgetTest, UntrackedAttemptIsRejectedBeforeAllocation) {
  Model model(tasks_); auto reads = model.Start(true, 7, false); model.Drain();
  EXPECT_EQ(0, model.delegate.allocations); EXPECT_EQ(0, reads->count);
  EXPECT_EQ(0u, Budget::ReservedItems()); EXPECT_TRUE(base::IsDirectoryEmpty(model.directory.GetPath()));
}

TEST_F(RemotePaintDownloadBudgetTest, DuplicateCopyVariantCannotCreateAnotherSpool) {
  Model model(tasks_); const auto existing = model.directory.GetPath().AppendASCII("existing");
  ASSERT_TRUE(base::WriteFile(existing, "original")); model.delegate.duplicate = existing;
  auto reads = model.Start(true); model.Drain(); EXPECT_EQ(0, reads->count);
  model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
  std::string bytes; EXPECT_TRUE(base::ReadFileToString(existing, &bytes)); EXPECT_EQ("original", bytes);
}

TEST_F(RemotePaintDownloadBudgetTest, StandaloneManagerErasesActualOwnedItemAndGuid) {
  Model model(tasks_, true); model.Start(); model.Drain();
  ASSERT_EQ(1u, Budget::ReservedItems());
  download::SimpleDownloadManager::DownloadVector owned;
  model.manager->GetAllDownloads(&owned); ASSERT_EQ(1u, owned.size());
  // This is the real initialization callback that used to bypass the
  // non-persistent observer registration and allocate a DB-cache record.
  for (int i = 0; i < 3; ++i)
    model.manager->ReportBytesWasted(static_cast<Item*>(owned.front()));
  EXPECT_EQ(1u, model.manager->NativeDownloadRecordCountForTesting());
  tasks_.FastForwardBy(base::Minutes(6)); model.Drain();
  EXPECT_EQ(0u, Budget::ReservedItems()); EXPECT_EQ(0u, model.manager->NativeDownloadRecordCountForTesting());
  EXPECT_TRUE(base::IsDirectoryEmpty(model.directory.GetPath()));
}

TEST_F(RemotePaintDownloadBudgetTest, IntegratedWriteCapRejectsWholeOversizedChunk) {
  Model model(tasks_); model.Start(true, Budget::kFileBytes + 1); model.Drain();
  ASSERT_EQ(1u, model.delegate.items.size());
  EXPECT_NE(download::DownloadItem::COMPLETE, model.delegate.items.begin()->second->GetState());
  model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
  EXPECT_TRUE(base::IsDirectoryEmpty(model.directory.GetPath()));
}

TEST_F(RemotePaintDownloadBudgetTest, BudgetActivationIsExplicitAndSnapshotted) {
  command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-download-budget-v1");
  Budget disabled({}); EXPECT_FALSE(disabled.enabled());
  command_.GetProcessCommandLine()->AppendSwitch("remote-paint-download-budget-v1");
  EXPECT_FALSE(disabled.enabled());
  command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-token");
  Budget missing_native({}); EXPECT_FALSE(missing_native.enabled());
}

#if BUILDFLAG(IS_POSIX)
TEST_F(RemotePaintDownloadBudgetTest, FailedCrossFilesystemRenameLeavesNoPlaceholder) {
  base::ScopedTempDir from, to; ASSERT_TRUE(from.CreateUniqueTempDir());
  ASSERT_TRUE(to.CreateUniqueTempDirUnderPath(base::FilePath("/dev/shm")));
  base::stat_wrapper_t source_stat{}, target_stat{};
  ASSERT_EQ(0, base::File::Stat(from.GetPath(), &source_stat));
  ASSERT_EQ(0, base::File::Stat(to.GetPath(), &target_stat));
  ASSERT_NE(source_stat.st_dev, target_stat.st_dev);
  download::BaseFile file(download::DownloadItem::kInvalidId); int64_t wasted = 0;
  ASSERT_EQ(kNone, file.Initialize({}, from.GetPath(), base::File(), 0, {}, std::nullopt, false, &wasted));
  const auto destination = to.GetPath().AppendASCII("no-placeholder");
  EXPECT_NE(kNone, file.Rename(destination)); EXPECT_FALSE(base::PathExists(destination));
  EXPECT_TRUE(file.CancelAndReportDeletion());
}
#endif

TEST_F(RemotePaintDownloadBudgetTest, FailedCleanupHoldsQuotaUntilActualProcessExit) {
  const auto* current = base::CommandLine::ForCurrentProcess();
  if (!current->HasSwitch("native-download-budget-failure-child")) {
    base::CommandLine child = *current;
    child.AppendSwitch("native-download-budget-failure-child");
    child.RemoveSwitch("gtest_filter"); child.AppendSwitchASCII("gtest_filter",
        "RemotePaintDownloadBudgetTest.FailedCleanupHoldsQuotaUntilActualProcessExit");
    child.RemoveSwitch("gtest_output");
    const std::string output = current->GetSwitchValueASCII("gtest_output");
    if (output.starts_with("json:")) {
      const auto dir = base::FilePath::FromUTF8Unsafe(output.substr(5)).DirName();
      child.AppendSwitchASCII("gtest_output", "json:" + dir.AppendASCII("failure-child.json").AsUTF8Unsafe());
    }
    auto process = base::LaunchProcess(child, base::LaunchOptions()); ASSERT_TRUE(process.IsValid());
    int code = -1;
    { base::ScopedAllowBaseSyncPrimitivesForTesting allow_wait;
      ASSERT_TRUE(process.WaitForExitWithTimeout(base::Seconds(30), &code)); }
    EXPECT_EQ(0, code); EXPECT_EQ(0u, Budget::ReservedItems()); return;
  }
  Model model(tasks_); model.Start(); model.Drain();
  ASSERT_EQ(1u, model.delegate.items.size());
  const auto path = model.delegate.items.begin()->second->GetFullPath();
  ASSERT_FALSE(path.empty()); ASSERT_TRUE(base::Move(path, model.directory.GetPath().AppendASCII("moved")));
  ASSERT_TRUE(base::CreateDirectory(path)); ASSERT_TRUE(base::WriteFile(path.AppendASCII("keep"), "keep"));
  model.RetireAll(); EXPECT_EQ(1u, Budget::ReservedItems());
  EXPECT_TRUE(model.delegate.items.begin()->second->GetRemotePaintAdmission()->failed());
  auto extra = model.Start(); model.Drain();
  EXPECT_EQ(2u, Budget::ReservedItems());  // The failed slot was never recycled.
  model.RetireAll(); EXPECT_EQ(1u, Budget::ReservedItems());
}
}  // namespace
