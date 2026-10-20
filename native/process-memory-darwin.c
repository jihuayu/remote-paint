// Test observer only. One persistent process reads owned Darwin processes via
// libproc; fixed binary batches stay under the original 64KiB output bound.
#include <errno.h>
#include <limits.h>
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>
#define MAX_PIDS 1024u
#define HEADER 32u
#define ROW 56u
#define MAX_SAFE UINT64_C(9007199254740991)
static uint32_t u32(const unsigned char *p){return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3];}
static uint64_t u64(const unsigned char *p){return ((uint64_t)u32(p)<<32)|u32(p+4);}
static void put32(unsigned char *p,uint32_t n){p[0]=n>>24;p[1]=n>>16;p[2]=n>>8;p[3]=n;}
static void put64(unsigned char *p,uint64_t n){put32(p,(uint32_t)(n>>32));put32(p+4,(uint32_t)n);}
static int input(void *data,size_t n){unsigned char *p=data;size_t done=0;while(done<n){ssize_t got=read(STDIN_FILENO,p+done,n-done);if(got<0&&errno==EINTR)continue;if(got<=0)return done==0&&got==0?0:-1;done+=(size_t)got;}return 1;}
static int output(const void *data,size_t n){const unsigned char *p=data;size_t done=0;while(done<n){ssize_t got=write(STDOUT_FILENO,p+done,n-done);if(got<0&&errno==EINTR)continue;if(got<=0)return 0;done+=(size_t)got;}return 1;}
static void header(unsigned char *p,uint64_t id,uint32_t count,uint32_t status,uint32_t detail,uint32_t failed_pid){memset(p,0,HEADER);memcpy(p,"RPM1",4);put32(p+4,1);put64(p+8,id);put32(p+16,count);put32(p+20,status);put32(p+24,detail);put32(p+28,failed_pid);}
// Status:1 malformed request,2 identity lookup,3 different UID,4 task memory,
// 5 rusage memory,6 changed identity. No incomplete batch or zero-fill escapes.
static uint32_t sample(uint32_t pid,unsigned char *p,uint32_t *error){
 struct proc_bsdinfo before={0},after={0};struct proc_taskinfo task={0};struct rusage_info_v4 usage={0};
 errno=0;if(proc_pidinfo((int)pid,PROC_PIDTBSDINFO,0,&before,sizeof(before))!=(int)sizeof(before)){*error=errno;return 2;}
 if(before.pbi_uid!=getuid()){*error=EACCES;return 3;}
 errno=0;if(proc_pidinfo((int)pid,PROC_PIDTASKINFO,0,&task,sizeof(task))!=(int)sizeof(task)){*error=errno;return 4;}
 errno=0;if(proc_pid_rusage((int)pid,RUSAGE_INFO_V4,(rusage_info_t *)&usage)!=0){*error=errno;return 5;}
 errno=0;if(proc_pidinfo((int)pid,PROC_PIDTBSDINFO,0,&after,sizeof(after))!=(int)sizeof(after)){*error=errno;return 2;}
 if(before.pbi_pid!=pid||after.pbi_pid!=pid||before.pbi_start_tvsec!=after.pbi_start_tvsec||before.pbi_start_tvusec!=after.pbi_start_tvusec||before.pbi_uid!=after.pbi_uid||before.pbi_ppid!=after.pbi_ppid){*error=ESRCH;return 6;}
 memset(p,0,ROW);put32(p,pid);put32(p+4,after.pbi_ppid);put32(p+8,after.pbi_uid);put32(p+12,7);put64(p+16,after.pbi_start_tvsec);put32(p+24,(uint32_t)after.pbi_start_tvusec);put64(p+32,task.pti_resident_size);put64(p+40,task.pti_virtual_size);put64(p+48,usage.ri_phys_footprint);return 0;
}
int main(void){
 signal(SIGPIPE,SIG_IGN);unsigned char response[HEADER+ROW*MAX_PIDS],request[16],pids[4*MAX_PIDS];
 header(response,0,0,0,(uint32_t)getpid(),MAX_PIDS);if(!output(response,HEADER))return 0;
 for(;;){
  int read_status=input(request,sizeof(request));if(read_status==0)return 0;if(read_status<0)return 1;
  uint64_t id=u64(request+4);uint32_t count=u32(request+12);
  if(memcmp(request,"RPQ1",4)||id==0||id>MAX_SAFE||count==0||count>MAX_PIDS){header(response,id,0,1,EINVAL,0);output(response,HEADER);return 1;}
  if(input(pids,count*4)!=1)return 1;
  uint32_t status=0,error=0,failed=0;
  for(uint32_t n=0;n<count;n++){
   uint32_t pid=u32(pids+4*n);if(pid==0||pid>INT_MAX){status=1;error=EINVAL;failed=pid;break;}
   for(uint32_t j=0;j<n;j++)if(u32(pids+4*j)==pid){status=1;error=EINVAL;failed=pid;break;}
   if(status)break;status=sample(pid,response+HEADER+ROW*n,&error);if(status){failed=pid;break;}
  }
  header(response,id,status?0:count,status,error,failed);if(!output(response,HEADER+(status?0:ROW*count)))return 0;
 }
}
