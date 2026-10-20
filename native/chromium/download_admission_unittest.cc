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
#include "base/json/string_escape.h"
#include "base/strings/string_util.h"
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
#include "components/download/public/common/mock_download_item.h"
#include "components/download/public/common/download_item_impl_delegate.h"
#include "components/download/public/common/download_target_info.h"
#include "components/download/public/common/download_task_runner.h"
#include "components/download/public/common/in_progress_download_manager.h"
#include "components/download/public/common/input_stream.h"
#include "components/download/public/common/native_download_budget.h"
#include "components/download/public/common/native_download_arm_window.h"
#include "components/download/public/common/native_download_request_context.h"
#include "components/download/public/common/native_download_read_session.h"
#include "components/download/public/common/native_download_transfer_registry.h"
#include "components/download/public/common/native_download_transfer_client.h"
#include "base/run_loop.h"
#include "base/test/test_future.h"
#include "base/threading/thread.h"
#include "base/strings/string_number_conversions.h"
#include "crypto/hash.h"
#if BUILDFLAG(IS_LINUX)
#include <dirent.h>
#include <sys/stat.h>
#endif

#include "components/download/public/common/url_download_handler.h"
#include "net/base/io_buffer.h"
#include "testing/gtest/include/gtest/gtest.h"

#if BUILDFLAG(IS_POSIX)
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace download {
class NativeDownloadReadSessionTestPeer {
 public:
  static std::unique_ptr<NativeDownloadReadSession> Open(
      NativeDownloadLease& lease, scoped_refptr<base::SequencedTaskRunner> runner,
      scoped_refptr<base::SequencedTaskRunner> origin, uint64_t limit,
      NativeDownloadReadSession::ReadyCallback done) {
    return lease.OpenReaderOn(std::move(runner), std::move(origin), limit, std::move(done));
  }
};
}

namespace {
using Budget = download::NativeDownloadBudget;
using ArmWindow = download::NativeDownloadArmWindow;
using Context = download::NativeDownloadRequestContext;
scoped_refptr<Context> RequestContext();
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
  std::vector<std::unique_ptr<download::DownloadUrlParameters>> resumes;
  void ResumeInterruptedDownload(std::unique_ptr<download::DownloadUrlParameters> params,
      const std::string&) override { resumes.push_back(std::move(params)); }
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
    CloseFixtureWindows();
    delegate.RejectPending(); hold_requests = false; CompleteRequests();
    manager.reset(); Drain();
    // On any unexpected failure the global reservation deliberately stays held.
    for (auto& [id, item] : delegate.items) item->Cancel(true);
    delegate.items.clear(); Drain();
  }
  // Simulate browser REQUEST CREATION from immutable Page/frame seeds before
  // creating a URL handler or delivering a response. Explicitly old/unknown
  // snapshots must use StartCaptured and are never repaired by this helper.
  scoped_refptr<Reads> Start(bool finish = false, size_t bytes = 7, bool tracked = true,
      scoped_refptr<Context> seed = nullptr, bool resume = false) {
    if (!seed) seed = RequestContext();
    scoped_refptr<Context> captured;
    if (seed) {
      if (ArmWindow::Capture(seed->page()).is_empty()) {
        auto window = ArmWindow::Open(*seed, Budget::kFileBytes, base::Seconds(30));
        if (window) fixture_windows_.push_back(window->id);
      }
      captured = Context::Create(seed->origin(), seed->target(), seed->initiator(), seed->page());
    }
    return StartCaptured(finish, bytes, tracked, std::move(captured), resume);
  }
  void CloseFixtureWindows() {
    for (const auto& id : fixture_windows_) ArmWindow::Close(id);
    fixture_windows_.clear();
  }
  scoped_refptr<Reads> StartCaptured(bool finish = false, size_t bytes = 7,
      bool tracked = true, scoped_refptr<Context> context = nullptr, bool resume = false) {
    last_context = context;
    auto owner = Handler::UniqueUrlDownloadHandlerPtr(new Handler,
        base::OnTaskRunnerDeleter(download::GetIOTaskRunner()));
    auto request = owner->GetRemotePaintRequestCleanupState();
    const auto id = reinterpret_cast<download::UrlDownloadHandlerID>(owner.get());
    static_cast<Handler::Delegate*>(manager.get())->OnUrlDownloadHandlerCreated(std::move(owner));
    requests.emplace_back(id, request);
    auto info = std::make_unique<download::DownloadCreateInfo>();
    info->is_new_download = !resume; info->result = kNone;
    if (resume) info->guid = delegate.items.empty() ? "missing-original-guid" : delegate.items.begin()->second->GetGuid();
    info->remote_paint_request_context = std::move(context);
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
    CloseFixtureWindows();
    std::vector<scoped_refptr<Lease>> leases;
    for (auto& [id, item] : delegate.items) leases.push_back(item->GetRemotePaintAdmission());
    for (auto& lease : leases) lease->BeginRetire();
    Drain();
  }
  base::ScopedTempDir directory;
  Items delegate;
  std::unique_ptr<Manager> manager;
  std::vector<std::pair<download::UrlDownloadHandlerID, scoped_refptr<Request>>> requests;
  scoped_refptr<Context> last_context;
  std::vector<base::UnguessableToken> fixture_windows_;
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
  model.CloseFixtureWindows();  // Close arms without crediting four actual leases.
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
  a.CloseFixtureWindows(); b.CloseFixtureWindows();
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

scoped_refptr<download::NativeDownloadRequestContext> RequestContext() {
  Context::Frame frame{1, 1, base::UnguessableToken::Create().ToString()};
  return Context::Create(Context::Origin::kExplicitRequest, frame, frame, frame);
}
TEST_F(RemotePaintDownloadBudgetTest, RetainedOriginalContextRejectsChangedDocumentBeforeResumeItem) {
  Model model(tasks_); auto original = RequestContext(); ASSERT_TRUE(original);
  model.Start(false, 7, true, original); model.Drain();
  auto lease = model.delegate.items.begin()->second->GetRemotePaintAdmission();
  const auto captured = model.last_context;
  EXPECT_NE(original, captured); EXPECT_TRUE(original->SamePageDocument(*captured));
  EXPECT_EQ(captured, lease->request_context());
  auto changed = RequestContext(); ASSERT_TRUE(changed);
  auto reads = model.Start(false, 7, true, changed, true); model.Drain();
  EXPECT_EQ(0, reads->count); EXPECT_EQ(1, model.delegate.allocations);
  EXPECT_EQ(download::DOWNLOAD_INTERRUPT_REASON_FILE_BLOCKED, model.last_started_reason);
  EXPECT_EQ(captured, lease->request_context()); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadBudgetTest, UnknownOriginalCannotBecomeKnownThroughResume) {
  Model model(tasks_); auto unknown = model.StartCaptured(); model.Drain();
  EXPECT_EQ(0, unknown->count); EXPECT_TRUE(model.delegate.items.empty());
  EXPECT_EQ(0, model.delegate.allocations); EXPECT_EQ(0u, Budget::ReservedItems());
  auto reads = model.Start(false, 7, true, RequestContext(), true); model.Drain();
  EXPECT_EQ(0, reads->count); EXPECT_EQ(0, model.delegate.allocations);
  EXPECT_TRUE(model.delegate.items.empty()); EXPECT_EQ(0u, Budget::ReservedItems());
  model.CloseFixtureWindows(); model.Start(true); model.Drain();
  EXPECT_EQ(1, model.delegate.allocations); model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}

using Reader = download::NativeDownloadReadSession;
using ReadError = Reader::Error;
class ReadFaultRunner : public base::SequencedTaskRunner {
 public:
  explicit ReadFaultRunner(scoped_refptr<base::SequencedTaskRunner> actual) : actual_(std::move(actual)) {}
  void RejectNext() { reject_next_ = true; }
  void RejectAll() { reject_all_ = true; }
  bool PostDelayedTask(const base::Location& from, base::OnceClosure task, base::TimeDelta delay) override {
    if (reject_all_ || reject_next_.exchange(false)) return false;
    return actual_->PostDelayedTask(from, std::move(task), delay);
  }
  bool PostNonNestableDelayedTask(const base::Location& from, base::OnceClosure task, base::TimeDelta delay) override {
    return PostDelayedTask(from, std::move(task), delay);
  }
  bool RunsTasksInCurrentSequence() const override { return actual_->RunsTasksInCurrentSequence(); }
 private:
  ~ReadFaultRunner() override = default;
  scoped_refptr<base::SequencedTaskRunner> actual_;
  std::atomic<bool> reject_next_{false}, reject_all_{false};
};
struct ReadGate : base::RefCountedThreadSafe<ReadGate> {
  base::WaitableEvent entered{base::WaitableEvent::ResetPolicy::MANUAL, base::WaitableEvent::InitialState::NOT_SIGNALED};
  base::WaitableEvent allow{base::WaitableEvent::ResetPolicy::MANUAL, base::WaitableEvent::InitialState::NOT_SIGNALED};
 private:
  friend class base::RefCountedThreadSafe<ReadGate>;
  ~ReadGate() = default;
};
#if BUILDFLAG(IS_LINUX)
struct ReadFileId { dev_t device; ino_t inode; };
ReadFileId Identity(const base::FilePath& path) {
  struct stat st{};
  if (stat(path.value().c_str(), &st) == 0) return {st.st_dev, st.st_ino};
  // Ready deliberately has no name. Resolve only this test process's actual
  // still-owned deleted FD, never a cached/logical identity or another PID.
  DIR* dir = opendir("/proc/self/fd"); EXPECT_NE(nullptr, dir); if (!dir) return {};
  bool found = false;
  while (const auto* entry = readdir(dir)) {
    int fd = -1; if (!base::StringToInt(entry->d_name, &fd)) continue;
    base::FilePath target;
    if (base::ReadSymbolicLink(base::FilePath("/proc/self/fd").AppendASCII(entry->d_name), &target) &&
        target.value() == path.value() + " (deleted)" && fstat(fd, &st) == 0 && S_ISREG(st.st_mode)) {
      found = true; break;
    }
  }
  closedir(dir); EXPECT_TRUE(found); return {st.st_dev, st.st_ino};
}
int OwnedReferences(ReadFileId identity) {
  int count = 0; DIR* dir = opendir("/proc/self/fd"); EXPECT_NE(nullptr, dir); if (!dir) return -1;
  while (const auto* entry = readdir(dir)) {
    int fd = -1; if (!base::StringToInt(entry->d_name, &fd)) continue;
    struct stat st{};
    if (fstat(fd, &st) == 0 && st.st_dev == identity.device && st.st_ino == identity.inode) ++count;
  }
  closedir(dir); return count;
}
#endif
class RemotePaintDownloadReadTest : public RemotePaintDownloadBudgetTest {
 protected:
  scoped_refptr<Lease> LeaseFor(Model& model) {
    EXPECT_EQ(1u, model.delegate.items.size()); return model.delegate.items.begin()->second->GetRemotePaintAdmission();
  }
  base::FilePath PathFor(Model& model) { return model.delegate.items.begin()->second->GetTargetFilePath(); }
  auto FilesFor(Model& model) { return model.delegate.items.begin()->second->GetRemotePaintFileCleanupState(); }
  std::unique_ptr<Reader> Open(Model& model, uint64_t maximum = Budget::kFileBytes,
      scoped_refptr<base::SequencedTaskRunner> runner = nullptr,
      scoped_refptr<base::SequencedTaskRunner> origin = nullptr) {
    base::test::TestFuture<Reader::Metadata> done;
    auto reader = runner ? download::NativeDownloadReadSessionTestPeer::Open(*LeaseFor(model), runner,
        origin ? origin : base::SequencedTaskRunner::GetCurrentDefault(), maximum, done.GetCallback())
        : LeaseFor(model)->OpenReader(maximum, done.GetCallback());
    if (runner) {
      auto barrier = base::MakeRefCounted<BarrierEvent>();
      runner->PostTask(FROM_HERE, base::BindOnce([](scoped_refptr<BarrierEvent> event) { event->data.Signal(); }, barrier));
      Wait(barrier->data);
    }
    tasks_.RunUntilIdle(); EXPECT_TRUE(done.IsReady());
    metadata_ = done.IsReady() ? done.Take() : Reader::Metadata{}; return reader;
  }
  Reader::Chunk Read(Reader& reader, uint64_t offset = 0, uint32_t bytes = Reader::kChunkBytes) {
    base::test::TestFuture<Reader::Chunk> done; EXPECT_TRUE(reader.Read(offset, bytes, done.GetCallback()));
    tasks_.RunUntilIdle(); EXPECT_TRUE(done.IsReady()); return done.IsReady() ? done.Take() : Reader::Chunk{};
  }
  void Wait(base::WaitableEvent& event) {
    base::ScopedAllowBaseSyncPrimitivesForTesting allow; ASSERT_TRUE(event.TimedWait(base::Seconds(10)));
  }
  auto BlockFileSequence() {
    auto gate = base::MakeRefCounted<ReadGate>();
    download::GetDownloadTaskRunner()->PostTask(FROM_HERE, base::BindOnce([](scoped_refptr<ReadGate> gate) {
      gate->entered.Signal(); base::ScopedAllowBaseSyncPrimitivesForTesting allow; gate->allow.Wait();
    }, gate));
    Wait(gate->entered); return gate;
  }
  auto ReleaseOnExit(scoped_refptr<ReadGate> gate) {
    return base::ScopedClosureRunner(base::BindOnce([](scoped_refptr<ReadGate> gate) { gate->allow.Signal(); }, gate));
  }
  void FileBarrier() {
    auto event = base::MakeRefCounted<BarrierEvent>();
    download::GetDownloadTaskRunner()->PostTask(FROM_HERE, base::BindOnce([](scoped_refptr<BarrierEvent> e) { e->data.Signal(); }, event));
    Wait(event->data);
  }
  bool Child(const char* kind, const char* test) {
    const auto* current = base::CommandLine::ForCurrentProcess();
    if (current->GetSwitchValueASCII("native-reader-failure-child") == kind) return true;
    auto child = *current; child.AppendSwitchASCII("native-reader-failure-child", kind);
    child.RemoveSwitch("gtest_filter"); child.AppendSwitchASCII("gtest_filter", std::string("RemotePaintDownloadReadTest.") + test);
    const auto output = current->GetSwitchValueASCII("gtest_output"); child.RemoveSwitch("gtest_output");
    if (output.starts_with("json:")) {
      auto directory = base::FilePath::FromUTF8Unsafe(output.substr(5)).DirName();
      child.AppendSwitchASCII("gtest_output", "json:" + directory.AppendASCII(std::string("reader-child-") + kind + ".json").AsUTF8Unsafe());
    }
    auto process = base::LaunchProcess(child, base::LaunchOptions()); EXPECT_TRUE(process.IsValid()); int code = -1;
    { base::ScopedAllowBaseSyncPrimitivesForTesting allow;
      EXPECT_TRUE(process.WaitForExitWithTimeout(base::Seconds(30), &code)); }
    EXPECT_EQ(0, code); EXPECT_EQ(0u, Budget::ReservedItems()); return false;
  }
  Reader::Metadata metadata_;
};

TEST_F(RemotePaintDownloadReadTest, CompletedFileMetadataHashAndBoundedChunks) {
  Model model(tasks_); model.Start(true, 7000); model.Drain(); auto reader = Open(model); ASSERT_TRUE(reader);
  EXPECT_EQ(ReadError::kNone, metadata_.error); EXPECT_EQ(7000u, metadata_.byte_length);
  EXPECT_EQ(base::HexEncodeLower(crypto::hash::Sha256(std::string(7000, 'x'))), metadata_.sha256);
  auto first = Read(*reader); EXPECT_EQ(ReadError::kNone, first.error); EXPECT_EQ(3072u, first.bytes.size()); EXPECT_FALSE(first.complete);
  auto last = Read(*reader, 6999); EXPECT_EQ("x", last.bytes); EXPECT_TRUE(last.complete);
  reader->Close(); tasks_.RunUntilIdle(); model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadReadTest, EmptyFileHashAndEndOfFileRemainValid) {
  Model model(tasks_); model.Start(true, 0); model.Drain(); auto reader = Open(model); ASSERT_TRUE(reader);
  EXPECT_EQ(ReadError::kNone, metadata_.error); EXPECT_EQ(0u, metadata_.byte_length);
  EXPECT_EQ(base::HexEncodeLower(crypto::hash::Sha256(std::string_view())), metadata_.sha256);
  auto result = Read(*reader); EXPECT_TRUE(result.bytes.empty()); EXPECT_TRUE(result.complete);
  reader->Close(); tasks_.RunUntilIdle(); model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadReadTest, ExactFourMiBFileDoesNotRequireWholeFileCopy) {
  Model model(tasks_); model.Start(true, Budget::kFileBytes); model.Drain(); auto reader = Open(model); ASSERT_TRUE(reader);
  EXPECT_EQ(ReadError::kNone, metadata_.error); EXPECT_EQ(Budget::kFileBytes, metadata_.byte_length);
  auto result = Read(*reader, Budget::kFileBytes - 1); EXPECT_EQ("x", result.bytes); EXPECT_TRUE(result.complete);
  reader->Close(); tasks_.RunUntilIdle(); model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadReadTest, RequestedByteLimitRejectsWithoutTruncatingFile) {
  Model model(tasks_); model.Start(true, 1048577); model.Drain(); const auto path = PathFor(model);
  auto reader = Open(model, 1048576); ASSERT_TRUE(reader); EXPECT_EQ(ReadError::kLimit, metadata_.error); EXPECT_TRUE(reader->closed());
  const auto length = base::GetFileSize(path); ASSERT_TRUE(length); EXPECT_EQ(1048577, *length);
  model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadReadTest, ActiveItemAndSecondReaderAreRejectedBeforeOpen) {
  Model active(tasks_); active.Start(); active.Drain(); base::test::TestFuture<Reader::Metadata> rejected;
  EXPECT_FALSE(LeaseFor(active)->OpenReader(Budget::kFileBytes, rejected.GetCallback())); EXPECT_FALSE(rejected.IsReady()); active.RetireAll();
  Model completed(tasks_); completed.Start(true); completed.Drain(); auto reader = Open(completed); ASSERT_TRUE(reader);
  EXPECT_FALSE(LeaseFor(completed)->OpenReader(Budget::kFileBytes, rejected.GetCallback())); EXPECT_FALSE(rejected.IsReady());
  reader->Close(); tasks_.RunUntilIdle(); EXPECT_FALSE(LeaseFor(completed)->OpenReader(Budget::kFileBytes, rejected.GetCallback()));
  completed.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadReadTest, InvalidRangesAndBusyReadDoNotQueueExtraWork) {
  Model model(tasks_); model.Start(true); model.Drain(); auto reader = Open(model); ASSERT_TRUE(reader);
  EXPECT_FALSE(reader->Read(0, 0, base::DoNothing())); EXPECT_FALSE(reader->Read(0, 3073, base::DoNothing()));
  EXPECT_FALSE(reader->Read(UINT64_MAX, 1, base::DoNothing())); EXPECT_FALSE(reader->Read(8, 1, base::DoNothing()));
  auto gate = BlockFileSequence(); auto release = ReleaseOnExit(gate);
  base::test::TestFuture<Reader::Chunk> first; ASSERT_TRUE(reader->Read(0, 1, first.GetCallback()));
  EXPECT_FALSE(reader->Read(0, 1, base::DoNothing())); EXPECT_FALSE(first.IsReady());
  gate->allow.Signal(); tasks_.RunUntilIdle(); EXPECT_TRUE(first.IsReady());
  reader->Close(); tasks_.RunUntilIdle(); model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadReadTest, UnlinkDoesNotRetireOwnedFileDescriptorOrReservation) {
  Model model(tasks_); model.Start(true); model.Drain(); const auto path = PathFor(model); const auto identity = Identity(path);
  EXPECT_EQ(0, OwnedReferences(identity)); auto reader = Open(model); ASSERT_TRUE(reader); EXPECT_EQ(1, OwnedReferences(identity));
  EXPECT_FALSE(base::PathExists(path)); EXPECT_EQ(1, OwnedReferences(identity)); EXPECT_EQ(1u, Budget::ReservedItems());
  auto result = Read(*reader); EXPECT_EQ("xxxxxxx", result.bytes);
  reader->Close(); tasks_.RunUntilIdle(); EXPECT_EQ(0, OwnedReferences(identity)); model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadReadTest, ActualFileClosureAndOriginAckAreSeparate) {
  Model model(tasks_); model.Start(true); model.Drain(); auto files = FilesFor(model); const auto identity = Identity(PathFor(model));
  auto reader = Open(model); ASSERT_TRUE(reader); EXPECT_EQ(1u, files->GetSnapshot().pending);
  auto gate = BlockFileSequence(); auto release = ReleaseOnExit(gate); bool closed = false;
  EXPECT_TRUE(reader->Close(base::BindOnce([](bool* closed, bool success) { *closed = success; }, &closed)));
  LeaseFor(model)->BeginRetire(); EXPECT_EQ(1, OwnedReferences(identity)); EXPECT_EQ(1u, Budget::ReservedItems());
  gate->allow.Signal(); FileBarrier();
  EXPECT_EQ(0, OwnedReferences(identity)); EXPECT_FALSE(closed); EXPECT_FALSE(reader->closed());
  EXPECT_GT(files->GetSnapshot().pending, 0u); EXPECT_EQ(1u, Budget::ReservedItems());
  model.Drain(); EXPECT_TRUE(closed); EXPECT_TRUE(reader->closed()); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadReadTest, CloseDuringAcceptedReadDiscardsResultBytes) {
  Model model(tasks_); model.Start(true); model.Drain(); auto reader = Open(model); ASSERT_TRUE(reader);
  auto gate = BlockFileSequence(); auto release = ReleaseOnExit(gate); base::test::TestFuture<Reader::Chunk> result;
  ASSERT_TRUE(reader->Read(0, 7, result.GetCallback())); EXPECT_TRUE(reader->Close()); LeaseFor(model)->BeginRetire();
  EXPECT_EQ(1u, Budget::ReservedItems()); gate->allow.Signal(); model.Drain();
  ASSERT_TRUE(result.IsReady()); EXPECT_EQ(ReadError::kClosed, result.Get().error); EXPECT_TRUE(result.Get().bytes.empty());
  EXPECT_TRUE(reader->closed()); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadReadTest, DroppingSessionStillClosesBeforeLeaseRelease) {
  Model model(tasks_); model.Start(true); model.Drain(); const auto identity = Identity(PathFor(model));
  auto reader = Open(model); ASSERT_TRUE(reader); auto gate = BlockFileSequence(); auto release = ReleaseOnExit(gate);
  reader.reset(); LeaseFor(model)->BeginRetire(); EXPECT_EQ(1, OwnedReferences(identity)); EXPECT_EQ(1u, Budget::ReservedItems());
  gate->allow.Signal(); model.Drain(); EXPECT_EQ(0, OwnedReferences(identity)); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadReadTest, TerminalDeadlineClosesActualReaderAndRecoversQuota) {
  Model model(tasks_); model.Start(true); model.Drain(); auto reader = Open(model); ASSERT_TRUE(reader);
  tasks_.FastForwardBy(base::Seconds(31)); model.Drain(); EXPECT_TRUE(reader->closed()); EXPECT_EQ(0u, Budget::ReservedItems());
  EXPECT_TRUE(model.delegate.items.empty()); model.Start(true); model.Drain(); model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadReadTest, TruncatedOwnedFileFailsReadAndAutoCloses) {
  Model model(tasks_); model.Start(true); model.Drain();
  base::File writer(PathFor(model), base::File::FLAG_OPEN | base::File::FLAG_READ | base::File::FLAG_WRITE); ASSERT_TRUE(writer.IsValid());
  auto reader = Open(model); ASSERT_TRUE(reader);
  ASSERT_TRUE(writer.SetLength(1)); auto result = Read(*reader); writer.Close(); EXPECT_EQ(ReadError::kIo, result.error);
  EXPECT_TRUE(result.bytes.empty()); tasks_.RunUntilIdle(); EXPECT_TRUE(reader->closed()); model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadReadTest, SymlinkDirectoryAndPipeAreRejectedWithoutBlocking) {
  for (int kind = 0; kind < 3; ++kind) {
    Model model(tasks_); model.Start(true); model.Drain(); const auto path = PathFor(model);
    const auto saved = model.directory.GetPath().AppendASCII("saved"); ASSERT_TRUE(base::Move(path, saved));
    if (kind == 0) ASSERT_TRUE(base::CreateSymbolicLink(saved, path));
    if (kind == 1) ASSERT_TRUE(base::CreateDirectory(path));
    if (kind == 2) ASSERT_EQ(0, mkfifo(path.value().c_str(), 0600));
    auto reader = Open(model); ASSERT_TRUE(reader); EXPECT_NE(ReadError::kNone, metadata_.error); EXPECT_TRUE(reader->closed());
    if (kind == 1) ASSERT_TRUE(base::DeletePathRecursively(path)); else ASSERT_TRUE(base::DeleteFile(path));
    ASSERT_TRUE(base::Move(saved, path)); model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
  }
}
TEST_F(RemotePaintDownloadReadTest, RejectedOpenCanAcknowledgeActualEmptyOwnerDestruction) {
  Model model(tasks_); model.Start(true); model.Drain(); auto fault = base::MakeRefCounted<ReadFaultRunner>(download::GetDownloadTaskRunner());
  fault->RejectNext(); auto reader = Open(model, Budget::kFileBytes, fault); ASSERT_TRUE(reader);
  EXPECT_NE(ReadError::kNone, metadata_.error); tasks_.RunUntilIdle(); EXPECT_TRUE(reader->closed());
  EXPECT_EQ(0u, FilesFor(model)->GetSnapshot().pending); model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadReadTest, StoppedFileSequenceHoldsQuotaUntilActualProcessExit) {
  if (!Child("stopped", "StoppedFileSequenceHoldsQuotaUntilActualProcessExit")) return;
  Model model(tasks_); model.Start(true); model.Drain(); const auto identity = Identity(PathFor(model)); auto files = FilesFor(model);
  base::Thread file_thread("owned-reader-file"); ASSERT_TRUE(file_thread.Start());
  auto reader = Open(model, Budget::kFileBytes, file_thread.task_runner()); ASSERT_TRUE(reader); ASSERT_EQ(ReadError::kNone, metadata_.error);
  EXPECT_EQ(1, OwnedReferences(identity)); file_thread.Stop(); EXPECT_FALSE(reader->Close()); LeaseFor(model)->BeginRetire(); model.Drain();
  EXPECT_EQ(1, OwnedReferences(identity)); EXPECT_EQ(1u, files->GetSnapshot().pending); EXPECT_TRUE(files->GetSnapshot().failed);
  EXPECT_EQ(1u, Budget::ReservedItems()); EXPECT_FALSE(reader->closed());
}
TEST_F(RemotePaintDownloadReadTest, InjectedDroppedCloseAckHoldsEvenAfterActualFileClosure) {
  if (!Child("ack-drop", "InjectedDroppedCloseAckHoldsEvenAfterActualFileClosure")) return;
  Model model(tasks_); model.Start(true); model.Drain(); const auto identity = Identity(PathFor(model)); auto files = FilesFor(model);
  auto origin = base::MakeRefCounted<ReadFaultRunner>(base::SequencedTaskRunner::GetCurrentDefault());
  auto reader = Open(model, Budget::kFileBytes, download::GetDownloadTaskRunner(), origin); ASSERT_TRUE(reader);
  origin->RejectAll(); EXPECT_TRUE(reader->Close()); LeaseFor(model)->BeginRetire(); model.Drain();
  EXPECT_EQ(0, OwnedReferences(identity)); EXPECT_EQ(1u, files->GetSnapshot().pending); EXPECT_FALSE(reader->closed());
  EXPECT_EQ(1u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadReadTest, TwelveReadSessionsAcrossDownloadsReuseActualQuota) {
  Model model(tasks_);
  for (int i = 0; i < 12; ++i) {
    model.Start(true); model.Drain(); auto reader = Open(model); ASSERT_TRUE(reader); EXPECT_EQ(ReadError::kNone, metadata_.error);
    EXPECT_EQ("xxxxxxx", Read(*reader).bytes); reader->Close(); tasks_.RunUntilIdle(); model.RetireAll();
    EXPECT_EQ(0u, Budget::ReservedItems()); EXPECT_TRUE(model.delegate.items.empty()); EXPECT_TRUE(base::IsDirectoryEmpty(model.directory.GetPath()));
  }
}


using Registry = download::NativeDownloadTransferRegistry;
using TransferState = Registry::State;
using TransferError = Registry::Error;
class RemotePaintDownloadTransferTest : public RemotePaintDownloadReadTest {
 protected:
  std::string Arm(Registry& registry, uint64_t maximum = Budget::kFileBytes, base::TimeDelta timeout = base::Seconds(10)) {
    auto ticket = registry.Arm(maximum, timeout); EXPECT_TRUE(ticket); return ticket.value_or("");
  }
  Registry::Snapshot Info(Registry& registry, const std::string& ticket) {
    auto info = registry.Info(ticket); EXPECT_TRUE(info);
    return info.value_or(Registry::Snapshot{TransferState::kIdle, TransferError::kUnavailable, 0, {}});
  }
  void Start(Model& model, Registry& registry, scoped_refptr<download::NativeDownloadRequestContext> owner,
             size_t bytes = 7) {
    model.Start(true, bytes, true, std::move(owner));
    ASSERT_TRUE(registry.Offer(LeaseFor(model))); model.Drain();
  }
  void Release(Model& model, Registry& registry, const std::string& ticket) {
    base::test::TestFuture<bool> done; EXPECT_TRUE(registry.Release(ticket, done.GetCallback()));
    model.Drain(); EXPECT_TRUE(done.IsReady()); if (done.IsReady()) EXPECT_TRUE(done.Take());
    EXPECT_TRUE(model.delegate.items.empty()); EXPECT_EQ(0u, Budget::ReservedItems());
  }
};
TEST_F(RemotePaintDownloadTransferTest, ArmBoundsProcessFlagAndOriginalOwner) {
  auto owner = RequestContext(); Registry registry(owner);
  EXPECT_FALSE(registry.Arm(0, base::Seconds(10))); EXPECT_FALSE(registry.Arm(Budget::kFileBytes + 1, base::Seconds(10)));
  EXPECT_FALSE(registry.Arm(1, base::TimeDelta())); EXPECT_FALSE(registry.Arm(1, base::Seconds(31)));
  Registry unknown(nullptr); EXPECT_FALSE(unknown.Arm(1, base::Seconds(1)));
  command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-download-budget-v1");
  Registry disabled(owner); EXPECT_FALSE(disabled.Arm(1, base::Seconds(1)));
  EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadTransferTest, OneTicketRetainedUntilExplicitRelease) {
  Model model(tasks_); Registry registry(RequestContext()); const auto ticket = Arm(registry);
  EXPECT_TRUE(ticket.starts_with("dl_")); EXPECT_EQ(39u, ticket.size()); EXPECT_FALSE(registry.Arm(1, base::Seconds(1)));
  EXPECT_EQ(TransferState::kArmed, Info(registry, ticket).state); EXPECT_EQ(0u, Budget::ReservedItems());
  Release(model, registry, ticket); EXPECT_FALSE(registry.Info(ticket));
  const auto second = Arm(registry); EXPECT_NE(ticket, second); Release(model, registry, second);
}
TEST_F(RemotePaintDownloadTransferTest, UnknownAndOtherPageAdmissionsAreRejected) {
  Model model(tasks_); auto owner = RequestContext(); Registry registry(owner); const auto ticket = Arm(registry);
  auto unknown = model.StartCaptured(); model.Drain();
  EXPECT_EQ(0, unknown->count); EXPECT_TRUE(model.delegate.items.empty());
  EXPECT_EQ(0, model.delegate.allocations); EXPECT_EQ(0u, Budget::ReservedItems());
  model.Start(false, 7, true, RequestContext()); EXPECT_FALSE(registry.Offer(LeaseFor(model)));
  EXPECT_EQ(TransferState::kArmed, Info(registry, ticket).state); model.RetireAll(); Release(model, registry, ticket);
}
TEST_F(RemotePaintDownloadTransferTest, AdmissionBeforeArmCannotBeReplayedIntoNewWindow) {
  Model model(tasks_); auto owner = RequestContext(); model.Start(true, 7, true, owner); model.Drain(); auto lease = LeaseFor(model);
  model.CloseFixtureWindows();  // Preserve old live lease, open a new arm identity.
  tasks_.FastForwardBy(base::Milliseconds(1)); Registry registry(owner); const auto ticket = Arm(registry);
  EXPECT_FALSE(registry.Offer(lease)); EXPECT_FALSE(lease->retiring()); model.RetireAll(); Release(model, registry, ticket);
}
TEST_F(RemotePaintDownloadTransferTest, OriginalPageAcceptsSubframeTargetAndInitiator) {
  Model model(tasks_); auto owner = RequestContext(); Registry registry(owner); const auto ticket = Arm(registry);
  const Context::Frame subframe{9, 10, base::UnguessableToken::Create().ToString()};
  auto context = Context::Create(Context::Origin::kRendererNavigation, subframe, subframe, owner->page()); ASSERT_TRUE(context);
  Start(model, registry, context); EXPECT_EQ(TransferState::kReady, Info(registry, ticket).state);
  EXPECT_EQ(model.last_context, LeaseFor(model)->request_context());
  EXPECT_TRUE(context->SamePageDocument(*model.last_context)); Release(model, registry, ticket);
}
TEST_F(RemotePaintDownloadTransferTest, OneLifetimeClaimAcrossTwoRegistries) {
  Model model(tasks_); auto owner = RequestContext(); Registry first(owner), second(owner);
  const auto a = Arm(first); EXPECT_FALSE(second.Arm(7, base::Seconds(10)));
  model.Start(true, 7, true, owner); auto lease = LeaseFor(model);
  EXPECT_TRUE(first.Offer(lease)); EXPECT_FALSE(first.Offer(lease)); EXPECT_FALSE(second.Offer(lease)); model.Drain();
  Release(model, first, a); EXPECT_TRUE(lease->finished()); const auto b = Arm(second);
  EXPECT_FALSE(second.Offer(lease)); model.Start(true, 7, true, owner);
  EXPECT_TRUE(second.Offer(LeaseFor(model))); model.Drain(); Release(model, second, b);
}
TEST_F(RemotePaintDownloadTransferTest, PendingCreatorThenActualReadyHashAndChunks) {
  Model model(tasks_); auto owner = RequestContext(); Registry registry(owner); const auto ticket = Arm(registry);
  model.Start(true, 7000, true, owner); EXPECT_TRUE(registry.Offer(LeaseFor(model)));
  EXPECT_EQ(TransferState::kPending, Info(registry, ticket).state); model.Drain();
  const auto info = Info(registry, ticket); EXPECT_EQ(TransferState::kReady, info.state); EXPECT_EQ(7000u, info.byte_length);
  EXPECT_EQ(base::HexEncodeLower(crypto::hash::Sha256(std::string(7000, 'x'))), info.sha256);
  base::test::TestFuture<Reader::Chunk> done; EXPECT_TRUE(registry.Read(ticket, 3072, 3072, done.GetCallback()));
  tasks_.RunUntilIdle(); ASSERT_TRUE(done.IsReady()); const auto chunk = done.Take();
  EXPECT_EQ(ReadError::kNone, chunk.error); EXPECT_EQ(3072u, chunk.offset); EXPECT_EQ(std::string(3072, 'x'), chunk.bytes); EXPECT_FALSE(chunk.complete);
  Release(model, registry, ticket);
}
TEST_F(RemotePaintDownloadTransferTest, StaleTicketCannotReadOrReleaseOwnedData) {
  Model model(tasks_); auto owner = RequestContext(); Registry registry(owner); const auto ticket = Arm(registry); Start(model, registry, owner);
  base::test::TestFuture<Reader::Chunk> read; base::test::TestFuture<bool> release;
  EXPECT_FALSE(registry.Info("dl_00000000-0000-4000-8000-000000000000"));
  EXPECT_FALSE(registry.Read("bad", 0, 7, read.GetCallback())); EXPECT_FALSE(registry.Release("bad", release.GetCallback()));
  EXPECT_FALSE(read.IsReady()); EXPECT_FALSE(release.IsReady()); EXPECT_EQ(1u, Budget::ReservedItems()); Release(model, registry, ticket);
}
TEST_F(RemotePaintDownloadTransferTest, SingleReadAdmissionIncludesCallbackDelivery) {
  Model model(tasks_); auto owner = RequestContext(); Registry registry(owner); const auto ticket = Arm(registry); Start(model, registry, owner);
  bool reentrant = true; base::test::TestFuture<Reader::Chunk> done;
  EXPECT_TRUE(registry.Read(ticket, 0, 7, base::BindOnce(
      [](Registry* registry, std::string ticket, bool* accepted, Reader::ReadCallback done, Reader::Chunk chunk) {
        *accepted = registry->Read(ticket, 0, 7, base::BindOnce([](Reader::Chunk) {})); std::move(done).Run(std::move(chunk));
      }, base::Unretained(&registry), ticket, base::Unretained(&reentrant), done.GetCallback())));
  EXPECT_FALSE(registry.Read(ticket, 0, 7, base::BindOnce([](Reader::Chunk) {})));
  tasks_.RunUntilIdle(); ASSERT_TRUE(done.IsReady()); EXPECT_EQ("xxxxxxx", done.Take().bytes); EXPECT_FALSE(reentrant); Release(model, registry, ticket);
}
TEST_F(RemotePaintDownloadTransferTest, ReleaseWaitsActualFileClosureAndItemMapAck) {
  Model model(tasks_); model.delegate.hold_metadata = true; auto owner = RequestContext(); Registry registry(owner); const auto ticket = Arm(registry);
  Start(model, registry, owner); const auto id = Identity(PathFor(model)); auto lease = LeaseFor(model);
  EXPECT_EQ(1, OwnedReferences(id)); base::test::TestFuture<bool> done; EXPECT_TRUE(registry.Release(ticket, done.GetCallback())); model.Drain();
  EXPECT_EQ(0, OwnedReferences(id)); EXPECT_TRUE(model.delegate.items.empty()); EXPECT_EQ(1u, model.delegate.metadata_acks.size());
  EXPECT_FALSE(done.IsReady()); EXPECT_FALSE(lease->finished()); EXPECT_EQ(1u, Budget::ReservedItems());
  EXPECT_FALSE(registry.Release(ticket, base::BindOnce([](bool) {}))); EXPECT_FALSE(registry.Arm(1, base::Seconds(1)));
  for (auto& ack : model.delegate.metadata_acks) ack->MetadataRetired(); model.delegate.metadata_acks.clear(); model.Drain();
  ASSERT_TRUE(done.IsReady()); EXPECT_TRUE(done.Take()); EXPECT_TRUE(lease->finished()); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadTransferTest, ReleaseWaitsActualUrlOwnerAcknowledgement) {
  Model model(tasks_); model.hold_requests = true; auto owner = RequestContext(); Registry registry(owner); const auto ticket = Arm(registry);
  model.Start(false, 7, true, owner); ASSERT_TRUE(registry.Offer(LeaseFor(model))); model.Drain();
  base::test::TestFuture<bool> done; EXPECT_TRUE(registry.Release(ticket, done.GetCallback())); model.Drain();
  EXPECT_FALSE(done.IsReady()); EXPECT_EQ(1u, Budget::ReservedItems());
  model.hold_requests = false; model.CompleteRequests(); model.Drain(); ASSERT_TRUE(done.IsReady()); EXPECT_TRUE(done.Take()); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadTransferTest, ReleaseReplyDeadlineKeepsUnsettledLeaseAndTicket) {
  Model model(tasks_); model.delegate.hold_metadata = true; auto owner = RequestContext(); Registry registry(owner); const auto ticket = Arm(registry);
  Start(model, registry, owner); auto lease = LeaseFor(model); base::test::TestFuture<bool> done;
  EXPECT_TRUE(registry.Release(ticket, done.GetCallback())); model.Drain(); tasks_.FastForwardBy(base::Seconds(31));
  ASSERT_TRUE(done.IsReady()); EXPECT_FALSE(done.Take()); EXPECT_FALSE(lease->finished()); EXPECT_EQ(1u, Budget::ReservedItems());
  EXPECT_TRUE(registry.Info(ticket)); EXPECT_FALSE(registry.Arm(1, base::Seconds(1)));
  for (auto& ack : model.delegate.metadata_acks) ack->MetadataRetired(); model.delegate.metadata_acks.clear(); model.Drain();
  EXPECT_TRUE(lease->finished()); EXPECT_EQ(0u, Budget::ReservedItems()); EXPECT_FALSE(registry.Info(ticket));
  const auto next = Arm(registry); Release(model, registry, next);
}
TEST_F(RemotePaintDownloadTransferTest, UnusedArmExpiresAndNeedsExplicitRelease) {
  Model model(tasks_); auto owner = RequestContext(); Registry registry(owner); const auto ticket = Arm(registry, 7, base::Seconds(1));
  tasks_.FastForwardBy(base::Seconds(2)); EXPECT_EQ(TransferState::kFailed, Info(registry, ticket).state);
  EXPECT_EQ(TransferError::kTimeout, Info(registry, ticket).error); EXPECT_FALSE(registry.Arm(1, base::Seconds(1)));
  model.Start(true, 7, true, owner); EXPECT_FALSE(registry.Offer(LeaseFor(model))); model.RetireAll(); Release(model, registry, ticket);
}
TEST_F(RemotePaintDownloadTransferTest, ReadyDeadlineClosesOwnedFileAndRetiresActualLease) {
  Model model(tasks_); auto owner = RequestContext(); Registry registry(owner); const auto ticket = Arm(registry, 7, base::Seconds(1));
  Start(model, registry, owner); const auto id = Identity(PathFor(model)); EXPECT_EQ(1, OwnedReferences(id));
  tasks_.FastForwardBy(base::Seconds(2)); model.Drain(); EXPECT_EQ(0, OwnedReferences(id)); EXPECT_EQ(0u, Budget::ReservedItems());
  EXPECT_EQ(TransferError::kTimeout, Info(registry, ticket).error); Release(model, registry, ticket);
}
TEST_F(RemotePaintDownloadTransferTest, InvalidateCannotRebindTicketToAnotherDocument) {
  Model model(tasks_); auto owner = RequestContext(); Registry registry(owner); const auto ticket = Arm(registry); Start(model, registry, owner);
  registry.Invalidate(); model.Drain(); EXPECT_EQ(TransferError::kUnavailable, Info(registry, ticket).error);
  EXPECT_FALSE(registry.Read(ticket, 0, 7, base::BindOnce([](Reader::Chunk) {}))); Release(model, registry, ticket);
  EXPECT_FALSE(registry.Arm(7, base::Seconds(10)));
}
TEST_F(RemotePaintDownloadTransferTest, DroppingRegistryClosesActualReaderBeforeQuotaReuse) {
  Model model(tasks_); auto owner = RequestContext(); auto registry = std::make_unique<Registry>(owner); const auto ticket = Arm(*registry);
  Start(model, *registry, owner); auto lease = LeaseFor(model); const auto id = Identity(PathFor(model)); EXPECT_EQ(1, OwnedReferences(id));
  registry.reset(); model.Drain(); EXPECT_EQ(0, OwnedReferences(id)); EXPECT_TRUE(lease->finished()); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadTransferTest, RequestedLimitAutoretiresOversizeActualFile) {
  Model model(tasks_); auto owner = RequestContext(); Registry registry(owner); const auto ticket = Arm(registry, 6);
  Start(model, registry, owner, 7); EXPECT_EQ(TransferError::kLimit, Info(registry, ticket).error);
  model.Drain(); EXPECT_EQ(0u, Budget::ReservedItems()); Release(model, registry, ticket);
}
TEST_F(RemotePaintDownloadTransferTest, TwelveCompletedCyclesReuseActualQuotaAndDistinctTickets) {
  Model model(tasks_); auto owner = RequestContext(); Registry registry(owner); std::string prior;
  for (int i = 0; i < 12; ++i) {
    const auto ticket = Arm(registry); EXPECT_NE(prior, ticket); prior = ticket; Start(model, registry, owner);
    EXPECT_EQ(TransferState::kReady, Info(registry, ticket).state); Release(model, registry, ticket);
    EXPECT_TRUE(base::IsDirectoryEmpty(model.directory.GetPath()));
  }
}
TEST_F(RemotePaintDownloadTransferTest, AcceptedReadPastDeadlineDiscardsActualContent) {
  Model model(tasks_); auto owner = RequestContext(); Registry registry(owner); const auto ticket = Arm(registry); Start(model, registry, owner);
  auto gate = BlockFileSequence(); auto unblock = ReleaseOnExit(gate); base::test::TestFuture<Reader::Chunk> done;
  ASSERT_TRUE(registry.Read(ticket, 0, 7, done.GetCallback())); tasks_.AdvanceClock(base::Seconds(11));
  gate->allow.Signal(); tasks_.RunUntilIdle(); ASSERT_TRUE(done.IsReady()); const auto chunk = done.Take();
  EXPECT_EQ(ReadError::kClosed, chunk.error); EXPECT_TRUE(chunk.bytes.empty()); model.Drain();
  EXPECT_EQ(TransferError::kTimeout, Info(registry, ticket).error); Release(model, registry, ticket);
}
TEST_F(RemotePaintDownloadTransferTest, FailedPhysicalCleanupNeverReportsReleaseSuccess) {
  const auto* current = base::CommandLine::ForCurrentProcess();
  if (!current->HasSwitch("native-transfer-failure-child")) {
    auto child = *current; child.AppendSwitch("native-transfer-failure-child"); child.RemoveSwitch("gtest_filter");
    child.AppendSwitchASCII("gtest_filter", "RemotePaintDownloadTransferTest.FailedPhysicalCleanupNeverReportsReleaseSuccess");
    const auto output = current->GetSwitchValueASCII("gtest_output"); child.RemoveSwitch("gtest_output");
    if (output.starts_with("json:")) child.AppendSwitchASCII("gtest_output", "json:" + base::FilePath::FromUTF8Unsafe(output.substr(5)).DirName().AppendASCII("transfer-child-failure.json").AsUTF8Unsafe());
    auto process = base::LaunchProcess(child, base::LaunchOptions()); ASSERT_TRUE(process.IsValid()); int code = -1;
    { base::ScopedAllowBaseSyncPrimitivesForTesting allow; ASSERT_TRUE(process.WaitForExitWithTimeout(base::Seconds(30), &code)); }
    EXPECT_EQ(0, code); EXPECT_EQ(0u, Budget::ReservedItems()); return;
  }
  Model model(tasks_); auto owner = RequestContext(); Registry registry(owner); const auto ticket = Arm(registry); Start(model, registry, owner);
  auto receipt = registry.Retirement(ticket); ASSERT_TRUE(receipt);
  const auto path = PathFor(model); auto lease = LeaseFor(model); const auto id = Identity(path);
  EXPECT_FALSE(base::PathExists(path)); ASSERT_TRUE(base::CreateDirectory(path));
  ASSERT_TRUE(base::WriteFile(path.AppendASCII("keep"), "keep")); base::test::TestFuture<bool> done;
  EXPECT_TRUE(registry.Release(ticket, done.GetCallback())); model.Drain(); ASSERT_TRUE(done.IsReady()); EXPECT_FALSE(done.Take());
  EXPECT_EQ(0, OwnedReferences(id)); EXPECT_TRUE(lease->failed()); EXPECT_FALSE(lease->finished()); EXPECT_EQ(1u, Budget::ReservedItems());
  EXPECT_TRUE(registry.Info(ticket)); EXPECT_FALSE(registry.Arm(7, base::Seconds(10)));
  EXPECT_FALSE(receipt->retired()); registry.Invalidate(); model.Drain(); EXPECT_FALSE(receipt->retired());
}

class RemotePaintDownloadOwnerAccessTest : public RemotePaintDownloadReadTest {};
TEST_F(RemotePaintDownloadOwnerAccessTest, ActualItemVirtualAccessRetainsOriginalLeaseAndContext) {
  Model model(tasks_); auto context = RequestContext(); model.Start(true, 7, true, context); model.Drain();
  const auto captured = model.last_context; EXPECT_NE(context, captured);
  EXPECT_TRUE(context->SamePageDocument(*captured)); EXPECT_FALSE(captured->arm_id().is_empty());
  download::DownloadItem* item = model.delegate.items.begin()->second.get();
  auto lease = item->GetRemotePaintAdmission(); ASSERT_TRUE(lease); EXPECT_EQ(LeaseFor(model), lease);
  EXPECT_EQ(captured, lease->request_context()); EXPECT_EQ(item, lease->transfer_item());
  model.RetireAll(); EXPECT_TRUE(lease->finished()); EXPECT_EQ(nullptr, lease->transfer_item()); EXPECT_EQ(0u, Budget::ReservedItems());
  EXPECT_EQ(captured, lease->request_context());
}
TEST_F(RemotePaintDownloadOwnerAccessTest, CustomItemDefaultsToNoAdmissionWithoutDowncast) {
  download::MockDownloadItem custom; download::DownloadItem* item = &custom;
  EXPECT_FALSE(item->GetRemotePaintAdmission()); EXPECT_EQ(0u, Budget::ReservedItems());
}


using Client = download::NativeDownloadTransferClient;
class DeleteClientOnCancel : public download::DownloadItem::Observer {
 public:
  DeleteClientOnCancel(download::DownloadItem* item, base::OnceClosure drop) : item_(item), drop_(std::move(drop)) { item_->AddObserver(this); }
  ~DeleteClientOnCancel() override { if (item_) item_->RemoveObserver(this); }
  void OnDownloadUpdated(download::DownloadItem* item) override {
    if (item->GetState() != download::DownloadItem::CANCELLED || !drop_) return;
    item_->RemoveObserver(this); item_ = nullptr; auto drop = std::move(drop_); std::move(drop).Run();
  }
  void OnDownloadDestroyed(download::DownloadItem*) override { item_ = nullptr; }
 private:
  raw_ptr<download::DownloadItem> item_;
  base::OnceClosure drop_;
};
class RemotePaintDownloadClientTest : public RemotePaintDownloadReadTest {
 protected:
  std::string Arm(Client& client, const base::UnguessableToken& key, base::TimeDelta timeout = base::Seconds(10)) {
    auto ticket = client.Arm(key, Budget::kFileBytes, timeout); EXPECT_TRUE(ticket); return ticket.value_or("");
  }
  void Start(Model& model, Client& client, scoped_refptr<download::NativeDownloadRequestContext> context) {
    model.Start(true, 7, true, std::move(context)); ASSERT_TRUE(client.Offer(LeaseFor(model))); model.Drain();
  }
  void Release(Model& model, Client& client, const base::UnguessableToken& key, const std::string& ticket) {
    base::test::TestFuture<bool> done; EXPECT_TRUE(client.Release(key, ticket, done.GetCallback())); model.Drain();
    EXPECT_TRUE(done.IsReady()); if (done.IsReady()) EXPECT_TRUE(done.Take()); EXPECT_EQ(0u, Budget::ReservedItems());
  }
};
TEST_F(RemotePaintDownloadClientTest, EmptyClientAndRejectedArmDoNotBindTicket) {
  Model model(tasks_); Client client(RequestContext()); const auto key = base::UnguessableToken::Create();
  EXPECT_FALSE(client.Arm({}, 7, base::Seconds(10))); EXPECT_FALSE(client.Arm(key, 0, base::Seconds(10)));
  EXPECT_FALSE(client.OwnsClient(key)); const auto ticket = Arm(client, key); EXPECT_TRUE(client.OwnsClient(key));
  Release(model, client, key, ticket); EXPECT_FALSE(client.OwnsClient(key));
}
TEST_F(RemotePaintDownloadClientTest, OnlyOriginalClientAndTicketCanAccessActualData) {
  Model model(tasks_); auto context = RequestContext(); Client client(context);
  const auto key = base::UnguessableToken::Create(), other = base::UnguessableToken::Create(); const auto ticket = Arm(client, key);
  Start(model, client, context); EXPECT_FALSE(client.Info(other, ticket)); EXPECT_FALSE(client.Info(key, "bad"));
  EXPECT_FALSE(client.Read(other, ticket, 0, 7, base::BindOnce([](Reader::Chunk) {})));
  EXPECT_FALSE(client.Release(other, ticket, base::BindOnce([](bool) {}))); EXPECT_FALSE(client.OwnsClient(other));
  EXPECT_FALSE(client.Arm(other, 7, base::Seconds(10))); EXPECT_EQ(1u, Budget::ReservedItems()); Release(model, client, key, ticket);
}
TEST_F(RemotePaintDownloadClientTest, SuccessfulReleaseAllowsAnotherClientAfterRealRetirement) {
  Model model(tasks_); auto context = RequestContext(); Client client(context); const auto a = base::UnguessableToken::Create(), b = base::UnguessableToken::Create();
  const auto first = Arm(client, a); Start(model, client, context); Release(model, client, a, first);
  const auto second = Arm(client, b); EXPECT_NE(first, second); EXPECT_FALSE(client.Info(a, first)); Start(model, client, context); Release(model, client, b, second);
}
TEST_F(RemotePaintDownloadClientTest, ActualFileReadAdmitsOnlyOnePendingReply) {
  Model model(tasks_); auto context = RequestContext(); Client client(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key); Start(model, client, context);
  base::test::TestFuture<Reader::Chunk> done; EXPECT_TRUE(client.Read(key, ticket, 0, 7, done.GetCallback()));
  EXPECT_FALSE(client.Read(key, ticket, 0, 7, base::BindOnce([](Reader::Chunk) {}))); tasks_.RunUntilIdle(); ASSERT_TRUE(done.IsReady());
  const auto chunk = done.Take(); EXPECT_EQ(ReadError::kNone, chunk.error); EXPECT_EQ("xxxxxxx", chunk.bytes); EXPECT_TRUE(chunk.complete); Release(model, client, key, ticket);
}
TEST_F(RemotePaintDownloadClientTest, ReentrantReadIsRejectedUntilActualCallbackReturns) {
  Model model(tasks_); auto context = RequestContext(); Client client(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key); Start(model, client, context);
  bool accepted = true; base::test::TestFuture<Reader::Chunk> done;
  EXPECT_TRUE(client.Read(key, ticket, 0, 7, base::BindOnce(
      [](Client* client, base::UnguessableToken key, std::string ticket, bool* accepted, Reader::ReadCallback done, Reader::Chunk chunk) {
        *accepted = client->Read(key, ticket, 0, 7, base::BindOnce([](Reader::Chunk) {})); std::move(done).Run(std::move(chunk));
      }, base::Unretained(&client), key, ticket, base::Unretained(&accepted), done.GetCallback())));
  tasks_.RunUntilIdle(); EXPECT_TRUE(done.IsReady()); EXPECT_FALSE(accepted); Release(model, client, key, ticket);
}
TEST_F(RemotePaintDownloadClientTest, InvalidateSettlesReadOnceBeforeActualIoReturns) {
  Model model(tasks_); auto context = RequestContext(); Client client(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key); Start(model, client, context);
  auto gate = BlockFileSequence(); auto unblock = ReleaseOnExit(gate); int calls = 0; base::test::TestFuture<Reader::Chunk> done;
  EXPECT_TRUE(client.Read(key, ticket, 0, 7, base::BindOnce(
      [](int* calls, Reader::ReadCallback done, Reader::Chunk chunk) { ++*calls; std::move(done).Run(std::move(chunk)); }, base::Unretained(&calls), done.GetCallback())));
  client.Invalidate(); ASSERT_TRUE(done.IsReady()); EXPECT_EQ(ReadError::kClosed, done.Take().error); EXPECT_EQ(1, calls); EXPECT_EQ(1u, Budget::ReservedItems());
  EXPECT_FALSE(client.OwnsClient(key)); EXPECT_FALSE(client.Arm(key, 7, base::Seconds(10)));
  gate->allow.Signal(); model.Drain(); EXPECT_EQ(1, calls); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadClientTest, InvalidateSettlesBothReplySlotsWithoutRetirementCredit) {
  Model model(tasks_); auto context = RequestContext(); Client client(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key); Start(model, client, context);
  auto gate = BlockFileSequence(); auto unblock = ReleaseOnExit(gate); base::test::TestFuture<Reader::Chunk> read; base::test::TestFuture<bool> released;
  EXPECT_TRUE(client.Read(key, ticket, 0, 7, read.GetCallback())); EXPECT_TRUE(client.Release(key, ticket, released.GetCallback()));
  EXPECT_FALSE(client.Release(key, ticket, base::BindOnce([](bool) {}))); EXPECT_FALSE(read.IsReady()); EXPECT_FALSE(released.IsReady());
  client.Invalidate(); ASSERT_TRUE(read.IsReady()); ASSERT_TRUE(released.IsReady()); EXPECT_EQ(ReadError::kClosed, read.Take().error); EXPECT_FALSE(released.Take());
  EXPECT_EQ(1u, Budget::ReservedItems()); gate->allow.Signal(); model.Drain(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadClientTest, DestructionFreesReplyCapturesWhileActualLeaseRemainsHeld) {
  Model model(tasks_); auto context = RequestContext(); auto client = std::make_unique<Client>(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(*client, key); Start(model, *client, context);
  auto gate = BlockFileSequence(); auto unblock = ReleaseOnExit(gate); auto read_capture = base::MakeRefCounted<base::RefCountedData<int>>(0), release_capture = base::MakeRefCounted<base::RefCountedData<int>>(0);
  EXPECT_TRUE(client->Read(key, ticket, 0, 7, base::BindOnce([](scoped_refptr<base::RefCountedData<int>> capture, Reader::Chunk chunk) { ++capture->data; EXPECT_EQ(ReadError::kClosed, chunk.error); }, read_capture)));
  EXPECT_TRUE(client->Release(key, ticket, base::BindOnce([](scoped_refptr<base::RefCountedData<int>> capture, bool success) { ++capture->data; EXPECT_FALSE(success); }, release_capture)));
  EXPECT_FALSE(read_capture->HasOneRef()); EXPECT_FALSE(release_capture->HasOneRef()); client.reset();
  EXPECT_TRUE(read_capture->HasOneRef()); EXPECT_TRUE(release_capture->HasOneRef()); EXPECT_EQ(1, read_capture->data); EXPECT_EQ(1, release_capture->data); EXPECT_EQ(1u, Budget::ReservedItems());
  gate->allow.Signal(); model.Drain(); EXPECT_EQ(1, read_capture->data); EXPECT_EQ(1, release_capture->data); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadClientTest, SynchronousUnusedReleaseCanDestroyClient) {
  Model model(tasks_); auto client = std::make_unique<Client>(RequestContext()); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(*client, key); int replies = 0;
  EXPECT_TRUE(client->Release(key, ticket, base::BindOnce([](std::unique_ptr<Client>* slot, int* replies, bool success) {
    EXPECT_TRUE(success); ++*replies; slot->reset();
  }, base::Unretained(&client), base::Unretained(&replies))));
  EXPECT_FALSE(client); EXPECT_EQ(1, replies); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadClientTest, FirstInvalidationReplyCanDestroyOwnerBeforeSecondReply) {
  Model model(tasks_); auto context = RequestContext(); auto client = std::make_unique<Client>(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(*client, key); Start(model, *client, context);
  auto gate = BlockFileSequence(); auto unblock = ReleaseOnExit(gate); int reads = 0, releases = 0;
  EXPECT_TRUE(client->Read(key, ticket, 0, 7, base::BindOnce([](std::unique_ptr<Client>* slot, int* calls, Reader::Chunk chunk) {
    ++*calls; EXPECT_EQ(ReadError::kClosed, chunk.error); slot->reset();
  }, base::Unretained(&client), base::Unretained(&reads))));
  EXPECT_TRUE(client->Release(key, ticket, base::BindOnce([](int* calls, bool success) { ++*calls; EXPECT_FALSE(success); }, base::Unretained(&releases))));
  client->Invalidate(); EXPECT_FALSE(client); EXPECT_EQ(1, reads); EXPECT_EQ(1, releases); EXPECT_EQ(1u, Budget::ReservedItems());
  gate->allow.Signal(); model.Drain(); EXPECT_EQ(1, reads); EXPECT_EQ(1, releases); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadClientTest, SynchronousReleaseReplyCanArmAnotherClient) {
  Model model(tasks_); Client client(RequestContext()); const auto a = base::UnguessableToken::Create(), b = base::UnguessableToken::Create(); const auto first = Arm(client, a); std::string second;
  EXPECT_TRUE(client.Release(a, first, base::BindOnce([](Client* client, base::UnguessableToken key, std::string* next, bool success) {
    EXPECT_TRUE(success); auto ticket = client->Arm(key, 7, base::Seconds(10)); EXPECT_TRUE(ticket); if (ticket) *next = *ticket;
  }, base::Unretained(&client), b, base::Unretained(&second))));
  EXPECT_TRUE(client.OwnsClient(b)); EXPECT_NE(first, second); Release(model, client, b, second);
}
TEST_F(RemotePaintDownloadClientTest, ReleaseWaitsActualFileAndMetadataAck) {
  Model model(tasks_); model.delegate.hold_metadata = true; auto context = RequestContext(); Client client(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key); Start(model, client, context);
  const auto id = Identity(PathFor(model)); base::test::TestFuture<bool> done; EXPECT_TRUE(client.Release(key, ticket, done.GetCallback())); model.Drain();
  EXPECT_EQ(0, OwnedReferences(id)); EXPECT_TRUE(model.delegate.items.empty()); EXPECT_FALSE(done.IsReady()); EXPECT_TRUE(client.OwnsClient(key)); EXPECT_EQ(1u, Budget::ReservedItems());
  for (auto& ack : model.delegate.metadata_acks) ack->MetadataRetired(); model.delegate.metadata_acks.clear(); model.Drain();
  ASSERT_TRUE(done.IsReady()); EXPECT_TRUE(done.Take()); EXPECT_FALSE(client.OwnsClient(key)); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadClientTest, FailedReplyDeadlineKeepsBindingUntilLaterActualSettlement) {
  Model model(tasks_); model.delegate.hold_metadata = true; auto context = RequestContext(); Client client(context); const auto key = base::UnguessableToken::Create(), next = base::UnguessableToken::Create(); const auto ticket = Arm(client, key); Start(model, client, context);
  base::test::TestFuture<bool> done; EXPECT_TRUE(client.Release(key, ticket, done.GetCallback())); model.Drain(); tasks_.FastForwardBy(base::Seconds(31));
  ASSERT_TRUE(done.IsReady()); EXPECT_FALSE(done.Take()); EXPECT_TRUE(client.OwnsClient(key)); EXPECT_FALSE(client.Arm(next, 7, base::Seconds(10))); EXPECT_EQ(1u, Budget::ReservedItems());
  for (auto& ack : model.delegate.metadata_acks) ack->MetadataRetired(); model.delegate.metadata_acks.clear(); model.Drain();
  const auto second = Arm(client, next); EXPECT_FALSE(client.OwnsClient(key)); Release(model, client, next, second);
}
TEST_F(RemotePaintDownloadClientTest, RejectedReadDoesNotRetainCallbackCaptures) {
  Model model(tasks_); auto context = RequestContext(); Client client(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key); Start(model, client, context);
  auto capture = base::MakeRefCounted<base::RefCountedData<int>>(0);
  EXPECT_FALSE(client.Read(key, ticket, 8, 7, base::BindOnce([](scoped_refptr<base::RefCountedData<int>> capture, Reader::Chunk) { ++capture->data; }, capture)));
  EXPECT_TRUE(capture->HasOneRef()); EXPECT_EQ(0, capture->data); EXPECT_FALSE(client.Read(key, ticket, 0, 7, {})); EXPECT_FALSE(client.Release(key, ticket, {}));
  Release(model, client, key, ticket);
}
TEST_F(RemotePaintDownloadClientTest, ReadReplyDeadlineSettlesBeforeBlockedActualFileJobReturns) {
  Model model(tasks_); auto context = RequestContext(); Client client(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key); Start(model, client, context);
  auto gate = BlockFileSequence(); auto unblock = ReleaseOnExit(gate); auto capture = base::MakeRefCounted<base::RefCountedData<int>>(0);
  EXPECT_TRUE(client.Read(key, ticket, 0, 7, base::BindOnce([](scoped_refptr<base::RefCountedData<int>> capture, Reader::Chunk chunk) {
    ++capture->data; EXPECT_EQ(ReadError::kClosed, chunk.error); EXPECT_TRUE(chunk.bytes.empty());
  }, capture)));
  tasks_.AdvanceClock(base::Seconds(11)); base::RunLoop run; run.RunUntilIdle();
  EXPECT_FALSE(gate->allow.IsSignaled()); EXPECT_EQ(1, capture->data); EXPECT_TRUE(capture->HasOneRef()); EXPECT_EQ(1u, Budget::ReservedItems());
  gate->allow.Signal(); model.Drain(); EXPECT_EQ(1, capture->data); Release(model, client, key, ticket);
}
TEST_F(RemotePaintDownloadClientTest, TwelveDownloadsAcrossClientKeysReuseActualQuota) {
  Model model(tasks_); auto context = RequestContext(); Client client(context); std::string previous;
  for (int i = 0; i < 12; ++i) {
    const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key); EXPECT_NE(previous, ticket); previous = ticket;
    Start(model, client, context); base::test::TestFuture<Reader::Chunk> done; EXPECT_TRUE(client.Read(key, ticket, 0, 7, done.GetCallback())); tasks_.RunUntilIdle();
    ASSERT_TRUE(done.IsReady()); EXPECT_EQ("xxxxxxx", done.Take().bytes); Release(model, client, key, ticket); EXPECT_TRUE(base::IsDirectoryEmpty(model.directory.GetPath()));
  }
}
TEST_F(RemotePaintDownloadClientTest, ActualCancelObserverCanDestroyClientInsideExpiredInfo) {
  Model model(tasks_); auto context = RequestContext(); auto client = std::make_unique<Client>(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(*client, key);
  model.Start(false, 7, true, context); ASSERT_TRUE(client->Offer(LeaseFor(model))); model.Drain();
  DeleteClientOnCancel observer(model.delegate.items.begin()->second.get(), base::BindOnce([](std::unique_ptr<Client>* slot) { slot->reset(); }, base::Unretained(&client)));
  tasks_.AdvanceClock(base::Seconds(11)); auto* current = client.get(); EXPECT_FALSE(current->Info(key, ticket)); EXPECT_FALSE(client);
  model.Drain(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadClientTest, ActualCancelObserverCanDestroyCoreInsideExpiredReadOrOffer) {
  for (bool offering : {false, true}) {
    Model model(tasks_); auto context = RequestContext(); auto registry = std::make_unique<Registry>(context); auto ticket = registry->Arm(7, base::Seconds(10)); ASSERT_TRUE(ticket);
    model.Start(false, 7, true, context); auto lease = LeaseFor(model); ASSERT_TRUE(registry->Offer(lease)); model.Drain();
    DeleteClientOnCancel observer(model.delegate.items.begin()->second.get(), base::BindOnce([](std::unique_ptr<Registry>* slot) { slot->reset(); }, base::Unretained(&registry)));
    tasks_.AdvanceClock(base::Seconds(11)); auto* current = registry.get();
    if (offering) EXPECT_FALSE(current->Offer(lease));
    else {
      EXPECT_FALSE(current->Read(*ticket, 0, 7, base::BindOnce([](Reader::Chunk) {})));
    }
    EXPECT_FALSE(registry); model.Drain(); EXPECT_EQ(0u, Budget::ReservedItems());
  }
}


TEST_F(RemotePaintDownloadClientTest, SuggestedNameUnitBoundRejectsBeforeClaimAndAcceptsExactLimit) {
  Model model(tasks_); auto context = RequestContext(); Client client(context);
  const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key);
  model.Start(true, 7, true, context); auto lease = LeaseFor(model);
  EXPECT_FALSE(client.Offer(lease, std::string(514, 'a')));
  ASSERT_TRUE(client.Info(key, ticket)); EXPECT_TRUE(client.Info(key, ticket)->suggested_name.empty());
  const std::string name(513, 'a'); ASSERT_TRUE(client.Offer(lease, name)); model.Drain();
  ASSERT_TRUE(client.Info(key, ticket)); EXPECT_EQ(name, client.Info(key, ticket)->suggested_name);
  Release(model, client, key, ticket);
}
TEST_F(RemotePaintDownloadClientTest, SuggestedNameUtf8ByteBoundAcceptsExactThreeByteUnits) {
  Model model(tasks_); auto context = RequestContext(); Client client(context);
  const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key);
  model.Start(true, 7, true, context); auto lease = LeaseFor(model);
  std::string name; for (int i = 0; i < 513; ++i) name += "\xe4\xb8\xad";
  ASSERT_EQ(Client::kSuggestedNameBytes, name.size());
  EXPECT_FALSE(client.Offer(lease, name + "\xe4\xb8\xad"));
  ASSERT_TRUE(client.Offer(lease, name)); model.Drain();
  ASSERT_TRUE(client.Info(key, ticket)); EXPECT_EQ(name, client.Info(key, ticket)->suggested_name);
  Release(model, client, key, ticket);
}
TEST_F(RemotePaintDownloadClientTest, SuggestedNameCountsSurrogatePairAcrossSourceSliceBoundary) {
  Model model(tasks_); auto context = RequestContext(); Client client(context);
  const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key);
  model.Start(true, 7, true, context); auto lease = LeaseFor(model);
  EXPECT_FALSE(client.Offer(lease, std::string(512, 'a') + "\xf0\x9f\x98\x80"));
  const auto name = std::string(511, 'a') + "\xf0\x9f\x98\x80";
  ASSERT_TRUE(client.Offer(lease, name)); model.Drain();
  ASSERT_TRUE(client.Info(key, ticket)); EXPECT_EQ(name, client.Info(key, ticket)->suggested_name);
  Release(model, client, key, ticket);
}
TEST_F(RemotePaintDownloadClientTest, SuggestedNameInvalidUtf8CannotConsumeActualLeaseClaim) {
  Model model(tasks_); auto context = RequestContext(); Client client(context);
  const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key);
  model.Start(true, 7, true, context); auto lease = LeaseFor(model);
  EXPECT_FALSE(client.Offer(lease, "\xff")); EXPECT_FALSE(client.Offer(lease, "\xed\xa0\x80"));
  ASSERT_TRUE(client.Offer(lease, "actual.txt")); model.Drain();
  ASSERT_TRUE(client.Info(key, ticket)); EXPECT_EQ("actual.txt", client.Info(key, ticket)->suggested_name);
  Release(model, client, key, ticket);
}
TEST_F(RemotePaintDownloadClientTest, SuggestedNameCopiesOnlyAcceptedBorrowedPrefix) {
  Model model(tasks_); auto context = RequestContext(); Client client(context);
  const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key);
  model.Start(true, 7, true, context); std::string name = "kept.txt";
  ASSERT_TRUE(client.Offer(LeaseFor(model), name)); name.assign(10000, 'z'); model.Drain();
  ASSERT_TRUE(client.Info(key, ticket)); EXPECT_EQ("kept.txt", client.Info(key, ticket)->suggested_name);
  Release(model, client, key, ticket);
}
TEST_F(RemotePaintDownloadClientTest, OtherPageSuggestedNameDoesNotReplaceOriginalMetadata) {
  Model model(tasks_); auto context = RequestContext(); Client client(context);
  const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key);
  model.Start(true, 7, true, RequestContext()); EXPECT_FALSE(client.Offer(LeaseFor(model), "other.txt"));
  ASSERT_TRUE(client.Info(key, ticket)); EXPECT_TRUE(client.Info(key, ticket)->suggested_name.empty());
  model.RetireAll(); model.Start(true, 7, true, context);
  ASSERT_TRUE(client.Offer(LeaseFor(model), "original.txt")); model.Drain();
  ASSERT_TRUE(client.Info(key, ticket)); EXPECT_EQ("original.txt", client.Info(key, ticket)->suggested_name);
  Release(model, client, key, ticket);
}
TEST_F(RemotePaintDownloadClientTest, DuplicateOfferCannotRewriteClaimedSuggestedName) {
  Model model(tasks_); auto context = RequestContext(); Client client(context);
  const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key);
  model.Start(true, 7, true, context); auto lease = LeaseFor(model);
  ASSERT_TRUE(client.Offer(lease, "first.txt")); EXPECT_FALSE(client.Offer(lease, "changed.txt")); model.Drain();
  ASSERT_TRUE(client.Info(key, ticket)); EXPECT_EQ("first.txt", client.Info(key, ticket)->suggested_name);
  Release(model, client, key, ticket);
}
TEST_F(RemotePaintDownloadClientTest, SuccessfulRetirementClearsNameBeforeOtherClientAndDefaultOffer) {
  Model model(tasks_); auto context = RequestContext(); Client client(context);
  const auto first = base::UnguessableToken::Create(), second = base::UnguessableToken::Create();
  const auto a = Arm(client, first); model.Start(true, 7, true, context);
  ASSERT_TRUE(client.Offer(LeaseFor(model), "old.txt")); model.Drain(); Release(model, client, first, a);
  const auto b = Arm(client, second); ASSERT_TRUE(client.Info(second, b));
  EXPECT_TRUE(client.Info(second, b)->suggested_name.empty());
  model.Start(true, 7, true, context); ASSERT_TRUE(client.Offer(LeaseFor(model), "")); model.Drain();
  ASSERT_TRUE(client.Info(second, b)); EXPECT_EQ("download.bin", client.Info(second, b)->suggested_name);
  Release(model, client, second, b);
}
TEST_F(RemotePaintDownloadClientTest, SuggestedNameWorstJsonEscapingRemainsBounded) {
  Model model(tasks_); auto context = RequestContext(); Client client(context);
  const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key);
  model.Start(true, 7, true, context); const std::string name(513, '\x01');
  ASSERT_TRUE(client.Offer(LeaseFor(model), name)); model.Drain(); auto info = client.Info(key, ticket); ASSERT_TRUE(info);
  std::string encoded; base::EscapeJSONString(info->suggested_name, true, &encoded);
  EXPECT_EQ(513u * 6 + 2, encoded.size()); EXPECT_LT(encoded.size() + 1024, 6144u);
  Release(model, client, key, ticket);
}


TEST_F(RemotePaintDownloadClientTest, SuggestedNamePreservesValidUnicodeNoncharacters) {
  Model model(tasks_); auto context = RequestContext(); Client client(context);
  const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key);
  model.Start(true, 7, true, context);
  const std::string name = "name_\xef\xbf\xbf_\xf4\x8f\xbf\xbe.txt";
  EXPECT_FALSE(base::IsStringUTF8(name));
  EXPECT_TRUE(base::IsStringUTF8AllowingNoncharacters(name));
  ASSERT_TRUE(client.Offer(LeaseFor(model), name)); model.Drain();
  ASSERT_TRUE(client.Info(key, ticket)); EXPECT_EQ(name, client.Info(key, ticket)->suggested_name);
  Release(model, client, key, ticket);
}


class RemotePaintDownloadArmWindowTest : public RemotePaintDownloadReadTest {
 protected:
  ArmWindow::Window OpenWindow(scoped_refptr<Context> page,
      base::TimeDelta timeout = base::Seconds(10)) {
    auto window = ArmWindow::Open(*page, Budget::kFileBytes, timeout); EXPECT_TRUE(window);
    if (window) { windows_.push_back(window->id); return *window; }
    return {};
  }
  scoped_refptr<Context> Capture(scoped_refptr<Context> seed) {
    return Context::Create(seed->origin(), seed->target(), seed->initiator(), seed->page());
  }
  void TearDown() override {
    for (const auto& id : windows_) ArmWindow::Close(id);
    EXPECT_EQ(0u, ArmWindow::ActiveWindowsForTesting());
  }
  void Interrupt(Model& model) {
    auto* item = model.delegate.items.begin()->second.get(); item->Pause();
    item->DestinationError(download::DOWNLOAD_INTERRUPT_REASON_NETWORK_TIMEOUT, 0, std::nullopt);
    model.Drain(); EXPECT_EQ(download::DownloadItem::INTERRUPTED, item->GetState());
  }
  void ReleaseUnused(Registry& registry, const std::string& ticket) {
    base::test::TestFuture<bool> done; EXPECT_TRUE(registry.Release(ticket, done.GetCallback()));
    EXPECT_TRUE(done.IsReady()); if (done.IsReady()) EXPECT_TRUE(done.Take());
  }
  std::vector<base::UnguessableToken> windows_;
};
TEST_F(RemotePaintDownloadArmWindowTest, SnapshotBeforeArmNeverUpgradesWhenWindowOpens) {
  auto page = RequestContext(); auto old = Capture(page); EXPECT_TRUE(old->arm_id().is_empty());
  const auto window = OpenWindow(page); EXPECT_FALSE(ArmWindow::Consume(*old));
  EXPECT_TRUE(old->arm_id().is_empty()); auto fresh = Capture(page); EXPECT_EQ(window.id, fresh->arm_id());
  auto consumed = ArmWindow::Consume(*fresh); ASSERT_TRUE(consumed); EXPECT_EQ(window.id, consumed->id);
}
TEST_F(RemotePaintDownloadArmWindowTest, CapacityDuplicatePageAndReuseDoNotReserveLeaseBytes) {
  auto page = RequestContext(); const auto first = OpenWindow(page);
  EXPECT_FALSE(ArmWindow::Open(*page, 7, base::Seconds(10)));
  for (int i = 0; i < 3; ++i) OpenWindow(RequestContext());
  EXPECT_EQ(4u, ArmWindow::ActiveWindowsForTesting()); EXPECT_EQ(0u, Budget::ReservedItems());
  auto fifth = RequestContext(); EXPECT_FALSE(ArmWindow::Open(*fifth, 7, base::Seconds(10)));
  ArmWindow::Close(first.id); const auto next = OpenWindow(fifth); EXPECT_NE(first.id, next.id);
  EXPECT_EQ(4u, ArmWindow::ActiveWindowsForTesting()); EXPECT_EQ(0u, Budget::ReservedBytes());
}
TEST_F(RemotePaintDownloadArmWindowTest, WindowBoundsAndBothFlagsRequired) {
  auto page = RequestContext(); EXPECT_FALSE(ArmWindow::Open(*page, 0, base::Seconds(1)));
  EXPECT_FALSE(ArmWindow::Open(*page, Budget::kFileBytes + 1, base::Seconds(1)));
  EXPECT_FALSE(ArmWindow::Open(*page, 1, base::TimeDelta()));
  EXPECT_FALSE(ArmWindow::Open(*page, 1, base::Seconds(31)));
  command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-download-budget-v1");
  EXPECT_FALSE(ArmWindow::Open(*page, 1, base::Seconds(1)));
  command_.GetProcessCommandLine()->AppendSwitch("remote-paint-download-budget-v1");
  command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-token");
  EXPECT_FALSE(ArmWindow::Open(*page, 1, base::Seconds(1)));
}
TEST_F(RemotePaintDownloadArmWindowTest, OneConsumeAllowsRetryButNeverSecondNewDownload) {
  auto page = RequestContext(); const auto window = OpenWindow(page); auto first = Capture(page), second = Capture(page);
  EXPECT_NE(first->request_id(), second->request_id()); EXPECT_EQ(window.id, first->arm_id());
  EXPECT_FALSE(ArmWindow::AllowsResume(*first)); EXPECT_TRUE(ArmWindow::Consume(*first));
  EXPECT_FALSE(ArmWindow::Consume(*second)); EXPECT_TRUE(ArmWindow::AllowsResume(*first));
  EXPECT_TRUE(ArmWindow::AllowsResume(*second));
}
TEST_F(RemotePaintDownloadArmWindowTest, CapturedOldWindowCannotBindReopenedSamePage) {
  auto page = RequestContext(); const auto first = OpenWindow(page); auto old = Capture(page);
  ArmWindow::Close(first.id); const auto next = OpenWindow(page); auto fresh = Capture(page);
  EXPECT_NE(first.id, next.id); EXPECT_EQ(first.id, old->arm_id()); EXPECT_FALSE(ArmWindow::Consume(*old));
  EXPECT_EQ(next.id, fresh->arm_id()); EXPECT_TRUE(ArmWindow::Consume(*fresh));
}
TEST_F(RemotePaintDownloadArmWindowTest, CaptureMatchesAllOriginalPageFrameFields) {
  auto page = RequestContext(); OpenWindow(page);
  for (int part = 0; part < 3; ++part) {
    auto changed = page->page();
    if (part == 0) ++changed.process_id;
    if (part == 1) ++changed.routing_id;
    if (part == 2) changed.document_token = base::UnguessableToken::Create().ToString();
    auto request = Context::Create(Context::Origin::kExplicitRequest, page->target(), page->initiator(), changed);
    ASSERT_TRUE(request); EXPECT_TRUE(request->arm_id().is_empty()); EXPECT_FALSE(ArmWindow::Consume(*request));
  }
}
TEST_F(RemotePaintDownloadArmWindowTest, ClosingArmNeverRefundsLiveFileUrlItemReservation) {
  Model model(tasks_); model.Start(); model.Drain(); auto request = model.last_context;
  EXPECT_EQ(1u, Budget::ReservedItems()); EXPECT_TRUE(ArmWindow::AllowsResume(*request));
  model.CloseFixtureWindows(); EXPECT_EQ(0u, ArmWindow::ActiveWindowsForTesting());
  EXPECT_EQ(1u, Budget::ReservedItems()); EXPECT_FALSE(ArmWindow::AllowsResume(*request));
  OpenWindow(RequestContext()); EXPECT_EQ(1u, Budget::ReservedItems());
  model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadArmWindowTest, ExactDeadlineRejectsWithoutWaitingForUiTimer) {
  auto page = RequestContext(); OpenWindow(page, base::Seconds(1)); auto captured = Capture(page);
  tasks_.AdvanceClock(base::Milliseconds(999)); EXPECT_EQ(captured->arm_id(), ArmWindow::Capture(page->page()));
  tasks_.AdvanceClock(base::Milliseconds(1)); EXPECT_FALSE(ArmWindow::Consume(*captured));
  EXPECT_TRUE(ArmWindow::Capture(page->page()).is_empty()); EXPECT_EQ(0u, ArmWindow::ActiveWindowsForTesting());
}
TEST_F(RemotePaintDownloadArmWindowTest, ConcurrentConsumeHasExactlyOneWinner) {
  auto page = RequestContext(); OpenWindow(page); auto captured = Capture(page);
  base::Thread first("arm-first"), second("arm-second"); ASSERT_TRUE(first.Start()); ASSERT_TRUE(second.Start());
  auto one = base::MakeRefCounted<BarrierEvent>(), two = base::MakeRefCounted<BarrierEvent>(); std::atomic<int> won{0};
  auto claim = [](scoped_refptr<Context> request, std::atomic<int>* won, scoped_refptr<BarrierEvent> done) {
    if (ArmWindow::Consume(*request)) ++*won; done->data.Signal();
  };
  first.task_runner()->PostTask(FROM_HERE, base::BindOnce(claim, captured, &won, one));
  second.task_runner()->PostTask(FROM_HERE, base::BindOnce(claim, captured, &won, two));
  Wait(one->data); Wait(two->data); first.Stop(); second.Stop(); EXPECT_EQ(1, won.load());
}
TEST_F(RemotePaintDownloadArmWindowTest, FullRealQuotaLeavesValidArmAvailableAfterActualRetirement) {
  Model held(tasks_), candidate(tasks_); for (int i = 0; i < 4; ++i) held.Start(); held.Drain();
  held.CloseFixtureWindows(); auto page = RequestContext(); OpenWindow(page); auto request = Capture(page);
  auto rejected = candidate.StartCaptured(false, 7, true, request); candidate.Drain();
  EXPECT_EQ(0, rejected->count); EXPECT_EQ(0, candidate.delegate.allocations); EXPECT_EQ(4u, Budget::ReservedItems());
  EXPECT_FALSE(ArmWindow::AllowsResume(*request));
  auto retired = held.delegate.items.begin()->second->GetRemotePaintAdmission(); retired->BeginRetire(); held.Drain();
  ASSERT_EQ(3u, Budget::ReservedItems()); auto fresh = Capture(page); candidate.StartCaptured(true, 7, true, fresh); candidate.Drain();
  EXPECT_EQ(1, candidate.delegate.allocations); EXPECT_EQ(4u, Budget::ReservedItems()); EXPECT_TRUE(ArmWindow::AllowsResume(*fresh));
  held.RetireAll(); candidate.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadArmWindowTest, ActualAdmissionRejectsRequestCapturedBeforeArm) {
  Model model(tasks_); auto page = RequestContext(); auto old = Capture(page); Registry registry(page);
  auto ticket = registry.Arm(7, base::Seconds(10)); ASSERT_TRUE(ticket);
  auto rejected = model.StartCaptured(true, 7, true, old); model.Drain();
  EXPECT_EQ(0, rejected->count); EXPECT_EQ(0, model.delegate.allocations); EXPECT_EQ(0u, Budget::ReservedItems());
  auto fresh = Capture(page); model.StartCaptured(true, 7, true, fresh); ASSERT_EQ(1u, model.delegate.items.size());
  EXPECT_TRUE(registry.Offer(LeaseFor(model))); model.Drain(); base::test::TestFuture<bool> done;
  EXPECT_TRUE(registry.Release(*ticket, done.GetCallback())); model.Drain(); EXPECT_TRUE(done.IsReady()); if (done.IsReady()) EXPECT_TRUE(done.Take()); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadArmWindowTest, ActualAdmissionRejectsClosedWindowBeforeItemAllocation) {
  Model model(tasks_); auto page = RequestContext(); const auto first = OpenWindow(page); auto old = Capture(page);
  ArmWindow::Close(first.id); OpenWindow(page); auto rejected = model.StartCaptured(true, 7, true, old); model.Drain();
  EXPECT_EQ(0, rejected->count); EXPECT_EQ(0, model.delegate.allocations); EXPECT_EQ(0u, Budget::ReservedItems());
  model.StartCaptured(true, 7, true, Capture(page)); model.Drain(); EXPECT_EQ(1, model.delegate.allocations);
  model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadArmWindowTest, OneActualNewDownloadPerArmBeforeAnyTransferOffer) {
  Model first(tasks_), second(tasks_); auto page = RequestContext(); const auto window = OpenWindow(page);
  first.StartCaptured(false, 7, true, Capture(page)); first.Drain();
  auto rejected = second.StartCaptured(false, 7, true, Capture(page)); second.Drain();
  EXPECT_EQ(1, first.delegate.allocations); EXPECT_EQ(0, second.delegate.allocations); EXPECT_EQ(0, rejected->count);
  EXPECT_EQ(1u, Budget::ReservedItems()); first.RetireAll(); ArmWindow::Close(window.id);
  OpenWindow(page); second.StartCaptured(true, 7, true, Capture(page)); second.Drain();
  EXPECT_EQ(1, second.delegate.allocations); second.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadArmWindowTest, KnownPageWithoutArmIsRejectedBeforeStreamRead) {
  Model model(tasks_); auto known = RequestContext(); ASSERT_FALSE(known->request_id().is_empty());
  ASSERT_TRUE(known->arm_id().is_empty()); auto rejected = model.StartCaptured(true, 7, true, known); model.Drain();
  EXPECT_EQ(0, rejected->count); EXPECT_EQ(0, model.delegate.allocations); EXPECT_EQ(0u, Budget::ReservedItems());
  EXPECT_EQ(download::DOWNLOAD_INTERRUPT_REASON_FILE_BLOCKED, model.last_started_reason);
}
TEST_F(RemotePaintDownloadArmWindowTest, UnknownSnapshotIsNotRepairedFromAnArmedDocument) {
  Model model(tasks_); auto page = RequestContext(); OpenWindow(page);
  auto rejected = model.StartCaptured(true); model.Drain(); EXPECT_EQ(0, rejected->count);
  EXPECT_EQ(0, model.delegate.allocations); EXPECT_EQ(0u, Budget::ReservedItems());
  model.StartCaptured(true, 7, true, Capture(page)); model.Drain(); EXPECT_EQ(1, model.delegate.allocations);
  model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadArmWindowTest, ActualItemResumeMintsFreshOriginalWindowWitness) {
  Model model(tasks_); model.Start(); model.Drain(); const auto original = model.last_context;
  auto lease = LeaseFor(model); Interrupt(model); auto* item = model.delegate.items.begin()->second.get();
  item->Resume(true); model.Drain(); ASSERT_EQ(1u, model.delegate.resumes.size());
  auto params = std::move(model.delegate.resumes.front()); model.delegate.resumes.clear();
  ASSERT_TRUE(params->remote_paint_resume_request); ASSERT_TRUE(params->remote_paint_request_context);
  EXPECT_TRUE(params->remote_paint_resume_request->Matches(item->GetGuid()));
  EXPECT_FALSE(params->remote_paint_resume_request->Matches("wrong-guid"));
  EXPECT_EQ(original->arm_id(), params->remote_paint_request_context->arm_id());
  EXPECT_NE(original->request_id(), params->remote_paint_request_context->request_id());
  EXPECT_TRUE(original->SamePageDocument(*params->remote_paint_request_context));
  model.StartCaptured(true, 7, true, params->remote_paint_request_context, true); model.Drain();
  ASSERT_EQ(1u, model.delegate.items.size()); EXPECT_EQ(lease, LeaseFor(model)); EXPECT_EQ(1, model.delegate.allocations);
  EXPECT_EQ(download::DownloadItem::COMPLETE, model.delegate.items.begin()->second->GetState());
  model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
  EXPECT_TRUE(lease->HasOneRef());
  EXPECT_FALSE(params->remote_paint_resume_request->Matches(params->guid()));
}
TEST_F(RemotePaintDownloadArmWindowTest, ClosedOriginalWindowCannotMintResumeUnderNewArm) {
  Model model(tasks_); model.Start(); model.Drain(); auto original = model.last_context; Interrupt(model);
  model.CloseFixtureWindows(); const auto next = OpenWindow(original);
  model.delegate.items.begin()->second->Resume(true); model.Drain();
  EXPECT_TRUE(model.delegate.resumes.empty()); EXPECT_EQ(0u, Budget::ReservedItems());
  EXPECT_EQ(next.id, ArmWindow::Capture(original->page()));
  model.StartCaptured(true, 7, true, Capture(original)); model.Drain(); EXPECT_EQ(2, model.delegate.allocations);
  model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadArmWindowTest, ResumeResponseFromNewWindowRetiresOldLeaseWithoutClaimingNew) {
  Model model(tasks_); model.Start(); model.Drain(); auto original = model.last_context; auto lease = LeaseFor(model);
  model.CloseFixtureWindows(); OpenWindow(original); auto fresh = Capture(original);
  auto rejected = model.StartCaptured(false, 7, true, fresh, true); model.Drain();
  EXPECT_EQ(0, rejected->count); EXPECT_EQ(1, model.delegate.allocations); EXPECT_EQ(original, lease->request_context());
  EXPECT_EQ(0u, Budget::ReservedItems()); EXPECT_FALSE(ArmWindow::AllowsResume(*fresh));
  model.StartCaptured(true, 7, true, Capture(original)); model.Drain(); EXPECT_EQ(2, model.delegate.allocations);
  model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadArmWindowTest, ActualLateResponseRejectedBeforeOverdueCoreTimerRuns) {
  Model model(tasks_); auto page = RequestContext(); Registry registry(page); auto ticket = registry.Arm(7, base::Seconds(1)); ASSERT_TRUE(ticket);
  auto captured = Capture(page); tasks_.AdvanceClock(base::Seconds(1));
  auto rejected = model.StartCaptured(true, 7, true, captured); EXPECT_EQ(0, model.delegate.allocations);
  model.Drain(); EXPECT_EQ(0, rejected->count); EXPECT_EQ(0u, Budget::ReservedItems()); ReleaseUnused(registry, *ticket);
}
TEST_F(RemotePaintDownloadArmWindowTest, TwelveSamePageWindowsRejectOldSnapshotsAndReuseRealQuota) {
  Model model(tasks_); auto page = RequestContext(); Registry registry(page); scoped_refptr<Context> previous;
  for (int i = 0; i < 12; ++i) {
    auto ticket = registry.Arm(7, base::Seconds(10)); ASSERT_TRUE(ticket);
    if (previous) { auto stale = model.StartCaptured(true, 7, true, previous); EXPECT_EQ(0, stale->count); }
    auto current = Capture(page); if (previous) EXPECT_NE(previous->arm_id(), current->arm_id());
    model.StartCaptured(true, 7, true, current); ASSERT_TRUE(registry.Offer(LeaseFor(model))); model.Drain();
    base::test::TestFuture<bool> done; EXPECT_TRUE(registry.Release(*ticket, done.GetCallback())); model.Drain();
    EXPECT_TRUE(done.IsReady()); if (done.IsReady()) EXPECT_TRUE(done.Take()); EXPECT_EQ(0u, Budget::ReservedItems()); EXPECT_EQ(0u, ArmWindow::ActiveWindowsForTesting());
    EXPECT_TRUE(base::IsDirectoryEmpty(model.directory.GetPath())); previous = current;
  }
  EXPECT_EQ(12, model.delegate.allocations);
}


TEST_F(RemotePaintDownloadArmWindowTest, ActualRegistryKeepsOriginalArmThroughItemRetryAndReady) {
  Model model(tasks_); auto page = RequestContext(); Registry registry(page);
  auto ticket = registry.Arm(7, base::Seconds(10)); ASSERT_TRUE(ticket);
  model.Start(false, 7, true, page); auto lease = LeaseFor(model);
  ASSERT_TRUE(registry.Offer(lease)); model.Drain(); auto original = model.last_context;
  Interrupt(model); auto pending = registry.Info(*ticket); ASSERT_TRUE(pending);
  EXPECT_EQ(TransferState::kPending, pending->state); EXPECT_TRUE(ArmWindow::AllowsResume(*original));
  model.delegate.items.begin()->second->Resume(true); model.Drain(); ASSERT_EQ(1u, model.delegate.resumes.size());
  auto params = std::move(model.delegate.resumes.front()); model.delegate.resumes.clear();
  ASSERT_TRUE(params->remote_paint_resume_request); EXPECT_TRUE(params->remote_paint_resume_request->Matches(params->guid()));
  EXPECT_EQ(original->arm_id(), params->remote_paint_request_context->arm_id());
  model.StartCaptured(true, 7, true, params->remote_paint_request_context, true); model.Drain();
  auto ready = registry.Info(*ticket); ASSERT_TRUE(ready); EXPECT_EQ(TransferState::kReady, ready->state);
  EXPECT_EQ(7u, ready->byte_length); EXPECT_EQ(1, model.delegate.allocations); EXPECT_EQ(lease, LeaseFor(model));
  base::test::TestFuture<Reader::Chunk> read; EXPECT_TRUE(registry.Read(*ticket, 0, 7, read.GetCallback()));
  tasks_.RunUntilIdle(); ASSERT_TRUE(read.IsReady()); EXPECT_EQ("xxxxxxx", read.Take().bytes);
  base::test::TestFuture<bool> released; EXPECT_TRUE(registry.Release(*ticket, released.GetCallback())); model.Drain();
  EXPECT_TRUE(released.IsReady()); if (released.IsReady()) EXPECT_TRUE(released.Take());
  EXPECT_EQ(0u, Budget::ReservedItems()); EXPECT_EQ(0u, ArmWindow::ActiveWindowsForTesting());
  EXPECT_TRUE(lease->HasOneRef()); EXPECT_FALSE(params->remote_paint_resume_request->Matches(params->guid()));
}

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

using Receipt = download::NativeDownloadRetirementReceipt;
class RemotePaintDownloadRetirementTest : public RemotePaintDownloadClientTest {
 protected:
  void SetUp() override { RemotePaintDownloadClientTest::SetUp(); EXPECT_EQ(0u, Receipt::LiveReceiptsForTesting()); }
  void TearDown() override {
    for (const auto& id : windows_) ArmWindow::Close(id);
    tasks_.RunUntilIdle(); EXPECT_EQ(0u, Receipt::LiveReceiptsForTesting()); EXPECT_EQ(0u, Budget::ReservedItems());
  }
  auto Window(scoped_refptr<Context> context) {
    auto window = ArmWindow::Open(*context, 7, base::Seconds(10)); EXPECT_TRUE(window);
    if (window) windows_.push_back(window->id);
    return window;
  }
  void Ack(Model& model) {
    for (auto& lease : model.delegate.metadata_acks) lease->MetadataRetired();
    model.delegate.metadata_acks.clear(); model.Drain();
  }
  std::vector<base::UnguessableToken> windows_;
};
TEST_F(RemotePaintDownloadRetirementTest, UnusedArmReceiptSurvivesDocumentFacadeDestruction) {
  auto context = RequestContext(); auto client = std::make_unique<Client>(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(*client, key);
  auto receipt = client->Retirement(key, ticket); ASSERT_TRUE(receipt); EXPECT_FALSE(receipt->retired()); client.reset();
  EXPECT_TRUE(receipt->retired()); EXPECT_EQ(0u, Budget::ReservedItems()); EXPECT_TRUE(context->HasOneRef()); EXPECT_EQ(1u, Receipt::LiveReceiptsForTesting());
}
TEST_F(RemotePaintDownloadRetirementTest, ReceiptRetrievalRequiresOriginalClientAndExactTicket) {
  Client client(RequestContext()); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key);
  EXPECT_FALSE(client.Retirement(base::UnguessableToken::Create(), ticket)); EXPECT_FALSE(client.Retirement({}, ticket)); EXPECT_FALSE(client.Retirement(key, ticket + "x")); EXPECT_FALSE(client.Retirement(key, "bad"));
  auto receipt = client.Retirement(key, ticket); ASSERT_TRUE(receipt); client.Invalidate(); EXPECT_FALSE(client.Retirement(key, ticket)); EXPECT_TRUE(receipt->retired());
}
TEST_F(RemotePaintDownloadRetirementTest, MissingOfferDoesNotCreditAnAdmittedActualLease) {
  Model model(tasks_); model.delegate.hold_metadata = true; auto context = RequestContext(); Client client(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key); auto receipt = client.Retirement(key, ticket); ASSERT_TRUE(receipt);
  model.Start(true, 7, true, context); model.Drain(); ASSERT_EQ(1u, Budget::ReservedItems()); auto lease = LeaseFor(model);
  base::test::TestFuture<bool> release; ASSERT_TRUE(client.Release(key, ticket, release.GetCallback())); model.Drain();
  EXPECT_TRUE(model.delegate.items.empty()); EXPECT_FALSE(release.IsReady()); EXPECT_FALSE(receipt->retired()); EXPECT_EQ(1u, Budget::ReservedItems());
  Ack(model); ASSERT_TRUE(release.IsReady()); EXPECT_TRUE(release.Take()); EXPECT_TRUE(receipt->retired()); EXPECT_TRUE(lease->finished()); EXPECT_TRUE(lease->HasOneRef());
}
TEST_F(RemotePaintDownloadRetirementTest, UnofferedAdmissionRetiresAfterDocumentClientIsGone) {
  Model model(tasks_); model.delegate.hold_metadata = true; auto context = RequestContext(); auto client = std::make_unique<Client>(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(*client, key); auto receipt = client->Retirement(key, ticket); ASSERT_TRUE(receipt);
  model.Start(false, 7, true, context); model.Drain(); auto lease = LeaseFor(model); client.reset(); model.Drain();
  EXPECT_FALSE(receipt->retired()); EXPECT_EQ(1u, Budget::ReservedItems()); EXPECT_TRUE(model.delegate.items.empty()); Ack(model);
  EXPECT_TRUE(receipt->retired()); EXPECT_TRUE(lease->finished()); EXPECT_TRUE(lease->HasOneRef()); EXPECT_TRUE(context->HasOneRef());
}
TEST_F(RemotePaintDownloadRetirementTest, UnofferedCreatorMustReallyReturnBeforeReceiptCompletes) {
  Model model(tasks_); model.delegate.hold_creation = true; auto context = RequestContext(); auto client = std::make_unique<Client>(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(*client, key); auto receipt = client->Retirement(key, ticket); ASSERT_TRUE(receipt);
  auto reads = model.Start(false, 7, true, context); ASSERT_EQ(1u, Budget::ReservedItems()); client.reset(); model.Drain(); tasks_.FastForwardBy(base::Seconds(31)); model.Drain();
  EXPECT_FALSE(receipt->retired()); EXPECT_EQ(0, reads->count); EXPECT_EQ(0, model.delegate.allocations); EXPECT_EQ(1u, Budget::ReservedItems());
  model.delegate.RejectPending(); model.Drain(); EXPECT_TRUE(receipt->retired()); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadRetirementTest, ClaimedReaderDescriptorOutlivesFailureReplyUntilActualClose) {
  Model model(tasks_); auto context = RequestContext(); auto client = std::make_unique<Client>(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(*client, key); auto receipt = client->Retirement(key, ticket); ASSERT_TRUE(receipt); Start(model, *client, context); const auto id = Identity(PathFor(model));
  auto gate = BlockFileSequence(); auto unblock = ReleaseOnExit(gate); base::test::TestFuture<Reader::Chunk> read; ASSERT_TRUE(client->Read(key, ticket, 0, 7, read.GetCallback()));
  client.reset(); ASSERT_TRUE(read.IsReady()); EXPECT_EQ(ReadError::kClosed, read.Take().error); EXPECT_FALSE(receipt->retired()); EXPECT_EQ(1, OwnedReferences(id)); EXPECT_EQ(1u, Budget::ReservedItems());
  gate->allow.Signal(); model.Drain(); EXPECT_EQ(0, OwnedReferences(id)); EXPECT_TRUE(receipt->retired()); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadRetirementTest, UnofferedUrlOwnerAndOriginAckMustActuallyRetire) {
  Model model(tasks_); model.hold_requests = true; auto context = RequestContext(); auto client = std::make_unique<Client>(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(*client, key); auto receipt = client->Retirement(key, ticket); ASSERT_TRUE(receipt);
  model.Start(false, 7, true, context); model.Drain(); client.reset(); model.Drain(); EXPECT_FALSE(receipt->retired()); EXPECT_EQ(1u, Budget::ReservedItems());
  model.hold_requests = false; model.CompleteRequests(); model.Drain(); EXPECT_TRUE(receipt->retired()); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadRetirementTest, MissingOfferReleaseDeadlineCannotInventPhysicalCompletion) {
  Model model(tasks_); model.delegate.hold_metadata = true; auto context = RequestContext(); Client client(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key); auto receipt = client.Retirement(key, ticket); ASSERT_TRUE(receipt);
  model.Start(true, 7, true, context); model.Drain(); base::test::TestFuture<bool> release; ASSERT_TRUE(client.Release(key, ticket, release.GetCallback())); model.Drain(); tasks_.FastForwardBy(base::Seconds(31));
  ASSERT_TRUE(release.IsReady()); EXPECT_FALSE(release.Take()); EXPECT_FALSE(receipt->retired()); EXPECT_EQ(1u, Budget::ReservedItems()); Ack(model); EXPECT_TRUE(receipt->retired());
}
TEST_F(RemotePaintDownloadRetirementTest, FailedFacadeReplyIsSeparateFromLateActualReceipt) {
  Model model(tasks_); model.delegate.hold_metadata = true; auto context = RequestContext(); auto client = std::make_unique<Client>(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(*client, key); auto receipt = client->Retirement(key, ticket); ASSERT_TRUE(receipt); Start(model, *client, context);
  base::test::TestFuture<bool> release; ASSERT_TRUE(client->Release(key, ticket, release.GetCallback())); client->Invalidate(); ASSERT_TRUE(release.IsReady()); EXPECT_FALSE(release.Take()); client.reset(); model.Drain(); EXPECT_FALSE(receipt->retired()); Ack(model); EXPECT_TRUE(receipt->retired());
}
TEST_F(RemotePaintDownloadRetirementTest, SettledReceiptRetainsNeitherActualLeaseNorOriginalContext) {
  Model model(tasks_); auto context = RequestContext(); auto client = std::make_unique<Client>(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(*client, key); auto receipt = client->Retirement(key, ticket); ASSERT_TRUE(receipt); Start(model, *client, context); auto lease = LeaseFor(model); client.reset(); model.Drain();
  EXPECT_TRUE(receipt->retired()); EXPECT_TRUE(lease->finished()); EXPECT_TRUE(lease->HasOneRef()); EXPECT_TRUE(context->HasOneRef()); EXPECT_TRUE(model.delegate.items.empty()); EXPECT_EQ(0u, model.manager->NativeDownloadRecordCountForTesting());
}
TEST_F(RemotePaintDownloadRetirementTest, UnrelatedActualLeaseSettlementCannotCompleteOldReceipt) {
  Model old(tasks_), newer(tasks_); old.delegate.hold_metadata = true; auto a = RequestContext(), b = RequestContext(); Client first(a), second(b); const auto key = base::UnguessableToken::Create(); const auto ta = Arm(first, key), tb = Arm(second, key); auto ra = first.Retirement(key, ta), rb = second.Retirement(key, tb); ASSERT_TRUE(ra && rb);
  Start(old, first, a); Start(newer, second, b); first.Invalidate(); old.Drain(); base::test::TestFuture<bool> released; ASSERT_TRUE(second.Release(key, tb, released.GetCallback())); newer.Drain(); ASSERT_TRUE(released.IsReady()); EXPECT_TRUE(released.Take()); EXPECT_TRUE(rb->retired()); EXPECT_FALSE(ra->retired()); EXPECT_EQ(1u, Budget::ReservedItems()); Ack(old); EXPECT_TRUE(ra->retired());
}
TEST_F(RemotePaintDownloadRetirementTest, OldReceiptNeverAdoptsTheNextActualDocumentTicket) {
  Model model(tasks_); const auto key = base::UnguessableToken::Create(); auto context = RequestContext(); auto old = std::make_unique<Client>(context); const auto ticket = Arm(*old, key); auto receipt = old->Retirement(key, ticket); ASSERT_TRUE(receipt); old.reset(); EXPECT_TRUE(receipt->retired());
  auto next_context = RequestContext(); Client next(next_context); const auto next_ticket = Arm(next, key); auto current = next.Retirement(key, next_ticket); ASSERT_TRUE(current); EXPECT_NE(receipt, current); EXPECT_NE(ticket, next_ticket); EXPECT_FALSE(next.Retirement(key, ticket)); Start(model, next, next_context); EXPECT_FALSE(current->retired()); EXPECT_TRUE(receipt->retired()); Release(model, next, key, next_ticket); EXPECT_TRUE(current->retired());
}
TEST_F(RemotePaintDownloadRetirementTest, TinyReceiptSlotsHaveFixedEightObjectBoundAndRealReuse) {
  std::vector<scoped_refptr<Receipt>> held;
  for (size_t i = 0; i < Receipt::kMaxReceipts; ++i) {
    auto window = Window(RequestContext()); ASSERT_TRUE(window); auto receipt = ArmWindow::Retirement(window->id); ASSERT_TRUE(receipt); held.push_back(receipt); ArmWindow::Close(window->id); EXPECT_TRUE(receipt->retired());
  }
  EXPECT_EQ(8u, Receipt::LiveReceiptsForTesting()); EXPECT_EQ(0u, ArmWindow::ActiveWindowsForTesting()); EXPECT_EQ(0u, Budget::ReservedItems()); EXPECT_FALSE(ArmWindow::Open(*RequestContext(), 7, base::Seconds(10)));
  held.front().reset(); EXPECT_EQ(7u, Receipt::LiveReceiptsForTesting()); auto next = Window(RequestContext()); ASSERT_TRUE(next); EXPECT_EQ(8u, Receipt::LiveReceiptsForTesting()); ArmWindow::Close(next->id);
}
TEST_F(RemotePaintDownloadRetirementTest, FourOldLeasesAndFourNewWindowsFitWithoutQuotaCredit) {
  Model model(tasks_); std::vector<scoped_refptr<Receipt>> held;
  for (int i = 0; i < 4; ++i) model.Start(); model.Drain(); model.CloseFixtureWindows(); EXPECT_EQ(4u, Budget::ReservedItems());
  for (int i = 0; i < 4; ++i) { auto window = Window(RequestContext()); ASSERT_TRUE(window); held.push_back(ArmWindow::Retirement(window->id)); }
  EXPECT_EQ(8u, Receipt::LiveReceiptsForTesting()); EXPECT_EQ(4u, Budget::ReservedItems());
  for (const auto& receipt : held) receipt->Retire(); model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadRetirementTest, SealingWindowIsDistinctFromRequestingActualRetirement) {
  Model model(tasks_); auto context = RequestContext(); Client client(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key); auto receipt = client.Retirement(key, ticket); ASSERT_TRUE(receipt); model.Start(false, 7, true, context); model.Drain(); auto lease = LeaseFor(model);
  ArmWindow::Close(model.last_context->arm_id()); model.Drain(); EXPECT_FALSE(lease->retiring()); EXPECT_FALSE(receipt->retired()); EXPECT_EQ(1u, Budget::ReservedItems()); receipt->Retire(); model.Drain(); EXPECT_TRUE(lease->finished()); EXPECT_TRUE(receipt->retired());
}
TEST_F(RemotePaintDownloadRetirementTest, CrossThreadReceiptRetirementPostsOnlyToActualLeaseOrigin) {
  Model model(tasks_); auto context = RequestContext(); Client client(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key); auto receipt = client.Retirement(key, ticket); ASSERT_TRUE(receipt); model.Start(false, 7, true, context); model.Drain(); auto lease = LeaseFor(model);
  base::Thread other("receipt-retire"); ASSERT_TRUE(other.Start()); auto done = base::MakeRefCounted<BarrierEvent>(); ASSERT_TRUE(other.task_runner()->PostTask(FROM_HERE, base::BindOnce([](scoped_refptr<Receipt> receipt, decltype(done) done) { receipt->Retire(); done->data.Signal(); }, receipt, done)));
  { base::ScopedAllowBaseSyncPrimitivesForTesting allow; ASSERT_TRUE(done->data.TimedWait(base::Seconds(10))); } other.Stop(); EXPECT_FALSE(lease->retiring()); EXPECT_FALSE(receipt->retired()); model.Drain(); EXPECT_TRUE(receipt->retired()); EXPECT_TRUE(lease->finished());
}
TEST_F(RemotePaintDownloadRetirementTest, ExtraReleaseCannotRetainSecondReplyWhileReceiptPending) {
  Model model(tasks_); model.delegate.hold_metadata = true; auto context = RequestContext(); Client client(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key); auto receipt = client.Retirement(key, ticket); ASSERT_TRUE(receipt); Start(model, client, context); base::test::TestFuture<bool> release; ASSERT_TRUE(client.Release(key, ticket, release.GetCallback()));
  auto capture = base::MakeRefCounted<base::RefCountedData<int>>(0); EXPECT_FALSE(client.Release(key, ticket, base::BindOnce([](decltype(capture) capture, bool) { ++capture->data; }, capture))); EXPECT_TRUE(capture->HasOneRef()); EXPECT_EQ(0, capture->data); model.Drain(); EXPECT_FALSE(receipt->retired()); Ack(model); EXPECT_TRUE(release.Take()); EXPECT_TRUE(receipt->retired());
}
TEST_F(RemotePaintDownloadRetirementTest, TimedOutFacadeRefreshDropsOnlyTheActuallySettledOldBinding) {
  Model model(tasks_); model.delegate.hold_metadata = true; auto context = RequestContext(); Client client(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key); auto receipt = client.Retirement(key, ticket); ASSERT_TRUE(receipt); Start(model, client, context); base::test::TestFuture<bool> release; ASSERT_TRUE(client.Release(key, ticket, release.GetCallback())); model.Drain(); tasks_.FastForwardBy(base::Seconds(31)); ASSERT_TRUE(release.IsReady()); EXPECT_FALSE(release.Take()); EXPECT_TRUE(client.OwnsClient(key)); EXPECT_FALSE(receipt->retired()); Ack(model); EXPECT_TRUE(receipt->retired());
  base::test::TestFuture<bool> refreshed; EXPECT_FALSE(client.Release(key, ticket, refreshed.GetCallback())); EXPECT_FALSE(refreshed.IsReady()); EXPECT_FALSE(client.OwnsClient(key));
  const auto next = Arm(client, key); EXPECT_NE(ticket, next); Release(model, client, key, next);
}
TEST_F(RemotePaintDownloadRetirementTest, RetiredUnusedArmCannotBeUpgradedByAnOldCapturedResponse) {
  Model model(tasks_); auto context = RequestContext(); Client client(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key); auto receipt = client.Retirement(key, ticket); ASSERT_TRUE(receipt);
  auto captured = Context::Create(context->origin(), context->target(), context->initiator(), context->page()); ASSERT_FALSE(captured->arm_id().is_empty()); receipt->Retire(); EXPECT_TRUE(receipt->retired()); auto reads = model.StartCaptured(true, 7, true, captured); model.Drain(); EXPECT_EQ(0, reads->count); EXPECT_EQ(0, model.delegate.allocations); EXPECT_EQ(0u, Budget::ReservedItems()); EXPECT_TRUE(receipt->retired());
}
TEST_F(RemotePaintDownloadRetirementTest, TwelveRealDocumentCyclesReuseReceiptsWithoutLifetimeQuota) {
  Model model(tasks_); const auto key = base::UnguessableToken::Create();
  for (int i = 0; i < 12; ++i) {
    auto context = RequestContext(); auto client = std::make_unique<Client>(context); const auto ticket = Arm(*client, key); auto receipt = client->Retirement(key, ticket); ASSERT_TRUE(receipt); Start(model, *client, context); client.reset(); model.Drain(); EXPECT_TRUE(receipt->retired()); EXPECT_EQ(0u, Budget::ReservedItems()); receipt.reset(); EXPECT_EQ(0u, Receipt::LiveReceiptsForTesting());
  }
  EXPECT_EQ(12, model.delegate.allocations);
}

class RemotePaintDownloadDetachedReadTest : public RemotePaintDownloadClientTest {};
TEST_F(RemotePaintDownloadDetachedReadTest, ReadyRemovesOriginalNameAndReadsTheSameOwnedFd) {
  Model model(tasks_); model.Start(true, 7000); model.Drain(); const auto path = PathFor(model); const auto id = Identity(path); auto reader = Open(model); ASSERT_TRUE(reader); ASSERT_EQ(ReadError::kNone, metadata_.error);
  EXPECT_FALSE(base::PathExists(path)); EXPECT_EQ(1, OwnedReferences(id)); EXPECT_EQ(1u, Budget::ReservedItems()); EXPECT_EQ(base::HexEncodeLower(crypto::hash::Sha256(std::string(7000, 'x'))), metadata_.sha256);
  EXPECT_EQ(std::string(3072, 'x'), Read(*reader).bytes); auto last = Read(*reader, 6999); EXPECT_EQ("x", last.bytes); EXPECT_TRUE(last.complete); reader->Close(); tasks_.RunUntilIdle(); EXPECT_EQ(0, OwnedReferences(id)); EXPECT_EQ(1u, Budget::ReservedItems()); model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadDetachedReadTest, EmptyReadyHasNoNameAndPreservesEmptyDigestAndEof) {
  Model model(tasks_); model.Start(true, 0); model.Drain(); const auto path = PathFor(model); const auto id = Identity(path); auto reader = Open(model); ASSERT_TRUE(reader); ASSERT_EQ(ReadError::kNone, metadata_.error);
  EXPECT_FALSE(base::PathExists(path)); EXPECT_EQ(0u, metadata_.byte_length); EXPECT_EQ(base::HexEncodeLower(crypto::hash::Sha256(std::string_view())), metadata_.sha256); auto chunk = Read(*reader); EXPECT_TRUE(chunk.bytes.empty()); EXPECT_TRUE(chunk.complete); EXPECT_EQ(1, OwnedReferences(id)); reader->Close(); tasks_.RunUntilIdle(); model.RetireAll(); EXPECT_EQ(0, OwnedReferences(id));
}
TEST_F(RemotePaintDownloadDetachedReadTest, FourMiBReadyUnlinksBeforeReturningBoundedChunks) {
  Model model(tasks_); model.Start(true, Budget::kFileBytes); model.Drain(); const auto path = PathFor(model); auto reader = Open(model); ASSERT_TRUE(reader); ASSERT_EQ(ReadError::kNone, metadata_.error);
  EXPECT_FALSE(base::PathExists(path)); EXPECT_TRUE(base::IsDirectoryEmpty(model.directory.GetPath())); EXPECT_EQ(Budget::kFileBytes, metadata_.byte_length); EXPECT_EQ(base::HexEncodeLower(crypto::hash::Sha256(std::string(Budget::kFileBytes, 'x'))), metadata_.sha256); EXPECT_EQ(3072u, Read(*reader).bytes.size()); EXPECT_EQ("x", Read(*reader, Budget::kFileBytes - 1).bytes); EXPECT_EQ(1u, Budget::ReservedItems()); reader->Close(); tasks_.RunUntilIdle(); model.RetireAll();
}
TEST_F(RemotePaintDownloadDetachedReadTest, HardlinkAliasIsRejectedBeforeEitherNameIsRemoved) {
  Model model(tasks_); model.Start(true); model.Drain(); const auto path = PathFor(model), alias = model.directory.GetPath().AppendASCII("alias"); ASSERT_EQ(0, link(path.value().c_str(), alias.value().c_str())); auto reader = Open(model); ASSERT_TRUE(reader); EXPECT_EQ(ReadError::kIo, metadata_.error); EXPECT_TRUE(reader->closed());
  EXPECT_EQ(7, base::GetFileSize(path).value_or(-1)); EXPECT_EQ(7, base::GetFileSize(alias).value_or(-1)); EXPECT_EQ(1u, Budget::ReservedItems()); ASSERT_TRUE(base::DeleteFile(alias)); model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadDetachedReadTest, ReplacementAtOldNameCannotChangeReadyFdDataOrDigest) {
  Model model(tasks_); model.Start(true); model.Drain(); const auto path = PathFor(model); const auto id = Identity(path); auto reader = Open(model); ASSERT_TRUE(reader); ASSERT_EQ(ReadError::kNone, metadata_.error); ASSERT_FALSE(base::PathExists(path)); const auto digest = metadata_.sha256;
  ASSERT_TRUE(base::WriteFile(path, "foreign replacement")); EXPECT_EQ("xxxxxxx", Read(*reader).bytes); EXPECT_EQ(base::HexEncodeLower(crypto::hash::Sha256(std::string(7, 'x'))), digest); std::string replacement; ASSERT_TRUE(base::ReadFileToString(path, &replacement)); EXPECT_EQ("foreign replacement", replacement); EXPECT_EQ(1, OwnedReferences(id)); ASSERT_TRUE(base::DeleteFile(path)); reader->Close(); tasks_.RunUntilIdle(); model.RetireAll();
}
TEST_F(RemotePaintDownloadDetachedReadTest, SameSizeWriteWithRestoredMtimeCannotReuseOldDigest) {
  Model model(tasks_); model.Start(true); model.Drain(); base::File writer(PathFor(model), base::File::FLAG_OPEN | base::File::FLAG_READ | base::File::FLAG_WRITE); ASSERT_TRUE(writer.IsValid()); auto reader = Open(model); ASSERT_TRUE(reader); ASSERT_EQ(ReadError::kNone, metadata_.error);
  struct stat st{}; ASSERT_EQ(0, fstat(writer.GetPlatformFile(), &st)); ASSERT_EQ(7, pwrite(writer.GetPlatformFile(), "yyyyyyy", 7, 0));
#if BUILDFLAG(IS_APPLE)
  const timespec times[2]{st.st_atimespec, st.st_mtimespec};
#else
  const timespec times[2]{st.st_atim, st.st_mtim};
#endif
  ASSERT_EQ(0, futimens(writer.GetPlatformFile(), times)); auto chunk = Read(*reader); EXPECT_EQ(ReadError::kIo, chunk.error); EXPECT_TRUE(chunk.bytes.empty()); writer.Close(); tasks_.RunUntilIdle(); EXPECT_TRUE(reader->closed()); model.RetireAll();
}
TEST_F(RemotePaintDownloadDetachedReadTest, ActualUnlinkPermissionFailureCannotPublishReady) {
  Model model(tasks_); model.Start(true); model.Drain(); const auto path = PathFor(model); const auto id = Identity(path); ASSERT_TRUE(base::SetPosixFilePermissions(model.directory.GetPath(), 0500));
  auto restore = base::ScopedClosureRunner(base::BindOnce([](base::FilePath directory) { EXPECT_TRUE(base::SetPosixFilePermissions(directory, 0700)); }, model.directory.GetPath()));
  auto reader = Open(model); ASSERT_TRUE(reader); EXPECT_EQ(ReadError::kIo, metadata_.error); EXPECT_TRUE(reader->closed()); EXPECT_TRUE(metadata_.sha256.empty()); EXPECT_EQ(0, OwnedReferences(id)); EXPECT_TRUE(base::PathExists(path)); EXPECT_EQ(1u, Budget::ReservedItems()); restore.RunAndReset(); model.RetireAll(); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadDetachedReadTest, CloseBeforeOpenReplyDiscardsLateDetachedFileMetadata) {
  Model model(tasks_); model.Start(true); model.Drain(); const auto path = PathFor(model); const auto id = Identity(path); auto gate = BlockFileSequence(); auto unblock = ReleaseOnExit(gate); base::test::TestFuture<Reader::Metadata> ready; auto reader = LeaseFor(model)->OpenReader(Budget::kFileBytes, ready.GetCallback()); ASSERT_TRUE(reader); EXPECT_TRUE(reader->Close()); LeaseFor(model)->BeginRetire(); EXPECT_FALSE(ready.IsReady()); EXPECT_EQ(1u, Budget::ReservedItems()); gate->allow.Signal(); model.Drain(); ASSERT_TRUE(ready.IsReady()); EXPECT_EQ(ReadError::kClosed, ready.Get().error); EXPECT_TRUE(ready.Get().sha256.empty()); EXPECT_EQ(0, OwnedReferences(id)); EXPECT_FALSE(base::PathExists(path)); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadDetachedReadTest, RegistryReadyHasNoPathButReceiptWaitsFdAndMetadataAck) {
  Model model(tasks_); model.delegate.hold_metadata = true; auto context = RequestContext(); Client client(context); const auto key = base::UnguessableToken::Create(); const auto ticket = Arm(client, key); auto receipt = client.Retirement(key, ticket); ASSERT_TRUE(receipt); Start(model, client, context); const auto path = PathFor(model); const auto id = Identity(path); auto info = client.Info(key, ticket); ASSERT_TRUE(info); EXPECT_EQ(TransferState::kReady, info->state); EXPECT_FALSE(base::PathExists(path)); EXPECT_EQ(1, OwnedReferences(id));
  auto gate = BlockFileSequence(); auto unblock = ReleaseOnExit(gate); base::test::TestFuture<bool> released; ASSERT_TRUE(client.Release(key, ticket, released.GetCallback())); EXPECT_FALSE(released.IsReady()); EXPECT_FALSE(receipt->retired()); EXPECT_EQ(1, OwnedReferences(id)); gate->allow.Signal(); model.Drain(); EXPECT_EQ(0, OwnedReferences(id)); EXPECT_FALSE(released.IsReady()); EXPECT_FALSE(receipt->retired()); EXPECT_EQ(1u, Budget::ReservedItems());
  for (auto& held : model.delegate.metadata_acks) held->MetadataRetired(); model.delegate.metadata_acks.clear(); model.Drain(); ASSERT_TRUE(released.IsReady()); EXPECT_TRUE(released.Take()); EXPECT_TRUE(receipt->retired()); EXPECT_EQ(0u, Budget::ReservedItems());
}
TEST_F(RemotePaintDownloadDetachedReadTest, TwelveRealReadyCyclesLeaveNoNamedSpoolOrLifetimeQuota) {
  Model model(tasks_);
  for (int i = 0; i < 12; ++i) {
    model.Start(true); model.Drain(); const auto path = PathFor(model); const auto id = Identity(path); auto reader = Open(model); ASSERT_TRUE(reader); ASSERT_EQ(ReadError::kNone, metadata_.error); EXPECT_FALSE(base::PathExists(path)); EXPECT_TRUE(base::IsDirectoryEmpty(model.directory.GetPath())); EXPECT_EQ("xxxxxxx", Read(*reader).bytes); EXPECT_EQ(1, OwnedReferences(id)); reader->Close(); tasks_.RunUntilIdle(); model.RetireAll(); EXPECT_EQ(0, OwnedReferences(id)); EXPECT_EQ(0u, Budget::ReservedItems());
  }
  EXPECT_EQ(12, model.delegate.allocations);
}
}  // namespace
