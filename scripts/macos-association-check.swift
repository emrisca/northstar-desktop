import AppKit
import CoreServices
import UniformTypeIdentifiers

// Diagnostic for the macOS `.northstar.json` association. It reports what
// LaunchServices actually resolved, not what the bundle intended to declare.
// Usage: swift scripts/macos-association-check.swift /path/to/project.northstar.json
guard CommandLine.arguments.count == 2 else {
    fputs("usage: swift scripts/macos-association-check.swift <sample>\n", stderr)
    exit(2)
}

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)
print("sample:", url.path)
print("NSWorkspace:", NSWorkspace.shared.urlForApplication(toOpen: url)?.path ?? "nil")
if let unmanaged = LSCopyDefaultApplicationURLForURL(url as CFURL, .all, nil) {
    print("LSCopyDefaultApplicationURLForURL:", (unmanaged.takeRetainedValue() as URL).path)
} else {
    print("LSCopyDefaultApplicationURLForURL: nil")
}
if let values = try? url.resourceValues(forKeys: [.contentTypeKey]),
   let type = values.contentType {
    print("URLResourceValues.contentType:", type.identifier)
}
for type in ["public.json", "com.emrisca.northstar.project"] {
    if let unmanaged = LSCopyDefaultApplicationURLForContentType(type as CFString, .all, nil) {
        print("default for \(type):", (unmanaged.takeRetainedValue() as URL).path)
    } else {
        print("default for \(type): nil")
    }
    if let unmanaged = LSCopyAllRoleHandlersForContentType(type as CFString, .all) {
        let handlers = unmanaged.takeRetainedValue() as! [String]
        print("handlers for \(type):", handlers.joined(separator: ", "))
    } else {
        print("handlers for \(type): nil")
    }
}
