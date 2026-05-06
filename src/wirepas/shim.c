/*
 * LD_PRELOAD shim that captures all read/write calls on a target tty
 * (default /dev/ttyS3) and dumps each transfer as one hex line into
 * a log file. Zero deps beyond glibc.
 *
 * Build:
 *   gcc -shared -fPIC -O0 -o shim.so shim.c -ldl
 *
 * Use:
 *   SHIM_TTY=/dev/ttyS3 SHIM_LOG=/tmp/shim.log LD_PRELOAD=./shim.so <command>
 *
 * Each line in the log:
 *   OPEN <path> fd=<n>
 *   W <bytes> <hex>
 *   R <bytes> <hex>
 *   CLOSE fd=<n>
 *
 * Wrap the gatewaygo systemd start by setting LD_PRELOAD in its environment,
 * or run gatewaygo directly with LD_PRELOAD set.
 */

#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <pthread.h>
#include <sys/types.h>
#include <sys/stat.h>

static FILE *log_fp = NULL;
static int   target_fd = -1;
static char  target_path[256] = "/dev/ttyS3";
static char  log_path[256]    = "/tmp/shim.log";
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static int   inited = 0;

static void shim_init(void) {
  if (inited) return;
  pthread_mutex_lock(&mu);
  if (inited) { pthread_mutex_unlock(&mu); return; }
  const char *t = getenv("SHIM_TTY");
  if (t && *t) { strncpy(target_path, t, sizeof(target_path) - 1); target_path[sizeof(target_path)-1] = 0; }
  const char *l = getenv("SHIM_LOG");
  if (l && *l) { strncpy(log_path, l, sizeof(log_path) - 1); log_path[sizeof(log_path)-1] = 0; }
  log_fp = fopen(log_path, "w");
  if (log_fp) { setvbuf(log_fp, NULL, _IOLBF, 0); fprintf(log_fp, "# shim watching %s\n", target_path); }
  inited = 1;
  pthread_mutex_unlock(&mu);
}

static void log_xfer(char dir, const void *buf, ssize_t n) {
  if (!log_fp || n <= 0) return;
  pthread_mutex_lock(&mu);
  fprintf(log_fp, "%c %zd ", dir, n);
  const unsigned char *p = (const unsigned char *)buf;
  for (ssize_t i = 0; i < n; i++) fprintf(log_fp, "%02x", p[i]);
  fputc('\n', log_fp);
  pthread_mutex_unlock(&mu);
}

ssize_t read(int fd, void *buf, size_t count) {
  static ssize_t (*real)(int, void *, size_t) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "read");
  ssize_t n = real(fd, buf, count);
  if (fd == target_fd) { shim_init(); log_xfer('R', buf, n); }
  return n;
}

ssize_t write(int fd, const void *buf, size_t count) {
  static ssize_t (*real)(int, const void *, size_t) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "write");
  ssize_t n = real(fd, buf, count);
  if (fd == target_fd) { shim_init(); log_xfer('W', buf, n); }
  return n;
}

int open(const char *pathname, int flags, ...) {
  static int (*real)(const char *, int, ...) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "open");
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap; va_start(ap, flags);
    mode = va_arg(ap, mode_t);
    va_end(ap);
  }
  int fd = real(pathname, flags, mode);
  if (fd >= 0 && pathname && strcmp(pathname, target_path) == 0) {
    shim_init();
    target_fd = fd;
    if (log_fp) { pthread_mutex_lock(&mu); fprintf(log_fp, "OPEN %s fd=%d\n", pathname, fd); pthread_mutex_unlock(&mu); }
  }
  return fd;
}

int open64(const char *pathname, int flags, ...) {
  static int (*real)(const char *, int, ...) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "open64");
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap; va_start(ap, flags);
    mode = va_arg(ap, mode_t);
    va_end(ap);
  }
  int fd = real(pathname, flags, mode);
  if (fd >= 0 && pathname && strcmp(pathname, target_path) == 0) {
    shim_init();
    target_fd = fd;
    if (log_fp) { pthread_mutex_lock(&mu); fprintf(log_fp, "OPEN64 %s fd=%d\n", pathname, fd); pthread_mutex_unlock(&mu); }
  }
  return fd;
}

int openat(int dirfd, const char *pathname, int flags, ...) {
  static int (*real)(int, const char *, int, ...) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "openat");
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap; va_start(ap, flags);
    mode = va_arg(ap, mode_t);
    va_end(ap);
  }
  int fd = real(dirfd, pathname, flags, mode);
  if (fd >= 0 && pathname && strcmp(pathname, target_path) == 0) {
    shim_init();
    target_fd = fd;
    if (log_fp) { pthread_mutex_lock(&mu); fprintf(log_fp, "OPENAT %s fd=%d\n", pathname, fd); pthread_mutex_unlock(&mu); }
  }
  return fd;
}

int close(int fd) {
  static int (*real)(int) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "close");
  if (fd == target_fd && log_fp) {
    pthread_mutex_lock(&mu); fprintf(log_fp, "CLOSE fd=%d\n", fd); pthread_mutex_unlock(&mu);
    target_fd = -1;
  }
  return real(fd);
}
