import Foundation
import CoreGraphics

// Prints "sharing" (exit 0), "idle" (exit 1) or "unknown" (exit 2, reason on stderr).
let verbose = CommandLine.arguments.contains("--verbose")

func note(_ s: String) { if verbose { FileHandle.standardError.write(Data((s + "\n").utf8)) } }

typealias WatcherFn = @convention(c) () -> Bool

guard let lib = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY) else {
    FileHandle.standardError.write(Data("cannot load SkyLight\n".utf8))
    print("unknown")
    exit(2)
}
guard let sym = dlsym(lib, "CGSIsScreenWatcherPresent") else {
    FileHandle.standardError.write(Data("CGSIsScreenWatcherPresent not found\n".utf8))
    print("unknown")
    exit(2)
}
let watcher = unsafeBitCast(sym, to: WatcherFn.self)()
note("CGSIsScreenWatcherPresent=\(watcher)")

if watcher {
    print("sharing")
    exit(0)
}
print("idle")
exit(1)
