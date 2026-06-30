// SISP MapDrive - macOS menu bar app
// Mirrors the Windows tray app: connect/disconnect the lab SMB shares with one click,
// with a status icon that reflects whether anything is mounted.
//
// Build (no Xcode needed):   ./build.sh        (produces MapDrive.app)
// Or quick run:              swiftc MapDrive.swift -o MapDrive -framework Cocoa && ./MapDrive
//
// Mounting uses the system "mount volume" (AppleScript), so macOS shows its normal sign-in
// dialog once and can save the password to your Keychain; later mounts are silent.

import Cocoa

// MARK: - Config (kept in sync with mapdrive.sisp.com/config/share-presets.json)

struct Mode {
    let id: String
    let label: String
    let server: String
    let domain: String?      // SMB domain, e.g. "SIRIRAJ" for direct NAS; nil for gateway
    let loginHint: String
    let shares: [String]
}

let MODES: [Mode] = [
    Mode(id: "gateway",
         label: "Gateway (recommended)",
         server: "192.168.0.25",
         domain: nil,
         loginHint: "Sign in with your plain lab username.",
         shares: ["sisplockers", "Aj-Adisak", "Aj-Uraiwan", "amphunc", "CCADR", "CIK",
                  "CRCproject", "Migration", "MMproject", "MutationProfile", "Neoantigen",
                  "nikon", "Orientia", "pacbio", "PELproject", "Rarecyte-folder",
                  "admin_dept", "admin_sp", "filing", "hr", "it_others", "postgraduate",
                  "purchasing", "research", "undergraduate"]),
    Mode(id: "direct",
         label: "Direct NAS",
         server: "192.168.0.103",
         domain: "SIRIRAJ",
         loginHint: "Sign in as SIRIRAJ\\username.",
         shares: ["sisplockers", "Aj-Adisak", "Aj-Uraiwan", "amphunc", "CCADR", "CIK",
                  "Columbus-folder", "CRCproject", "Migration", "MMproject", "MutationProfile",
                  "Neoantigen", "nikon", "Orientia", "pacbio", "PELproject", "Rarecyte-folder",
                  "admin_dept", "admin_sp", "filing", "hr", "it_others", "postgraduate",
                  "purchasing", "research", "undergraduate"]),
]

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let defaults = UserDefaults.standard
    private var timer: Timer?

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory) // menu-bar only, no Dock icon
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        rebuildMenu()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.refresh() }
    }

    // MARK: state

    private var mode: Mode {
        let id = defaults.string(forKey: "mode") ?? "gateway"
        return MODES.first { $0.id == id } ?? MODES[0]
    }
    private var username: String { defaults.string(forKey: "username") ?? "" }

    private func mountedShares() -> Set<String> {
        let keys: [URLResourceKey] = [.volumeNameKey]
        let vols = FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: keys,
                                                         options: [.skipHiddenVolumes]) ?? []
        var out = Set<String>()
        for v in vols where v.path.hasPrefix("/Volumes/") {
            out.insert(v.lastPathComponent)
        }
        return out
    }

    // MARK: actions

    private func smbURL(for share: String) -> String {
        let m = mode
        var userPart = ""
        if !username.isEmpty {
            if let d = m.domain { userPart = "\(d);\(username)@" } else { userPart = "\(username)@" }
        }
        // Spaces / special chars in share names are rare here, but encode to be safe.
        let enc = share.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? share
        return "smb://\(userPart)\(m.server)/\(enc)"
    }

    @objc private func toggleShare(_ sender: NSMenuItem) {
        let share = sender.representedObject as! String
        if mountedShares().contains(share) {
            runShell("/usr/sbin/diskutil", ["unmount", "/Volumes/\(share)"])
        } else {
            mount(share)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.refresh() }
    }

    @objc private func connectAll() {
        for s in mode.shares where !mountedShares().contains(s) { mount(s) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { self.refresh() }
    }

    @objc private func disconnectAll() {
        for s in mountedShares() { runShell("/usr/sbin/diskutil", ["unmount", "/Volumes/\(s)"]) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.refresh() }
    }

    private func mount(_ share: String) {
        // AppleScript "mount volume" triggers the native sign-in dialog + Keychain save.
        let url = smbURL(for: share)
        let script = "try\nmount volume \"\(url)\"\nend try"
        if let s = NSAppleScript(source: script) {
            var err: NSDictionary?
            s.executeAndReturnError(&err)
        }
    }

    @objc private func openVolumes() {
        NSWorkspace.shared.open(URL(fileURLWithPath: "/Volumes"))
    }

    @objc private func setMode(_ sender: NSMenuItem) {
        defaults.set(sender.representedObject as! String, forKey: "mode")
        rebuildMenu(); refresh()
    }

    @objc private func setUsername() {
        let alert = NSAlert()
        alert.messageText = "Lab username"
        alert.informativeText = mode.loginHint
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        field.stringValue = username
        alert.accessoryView = field
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn {
            defaults.set(field.stringValue.trimmingCharacters(in: .whitespaces), forKey: "username")
            rebuildMenu()
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: UI

    private func refresh() {
        let mounted = mountedShares().filter { mode.shares.contains($0) }
        let connected = !mounted.isEmpty
        if let btn = statusItem.button {
            let symbol = connected ? "externaldrive.fill.badge.checkmark" : "externaldrive.badge.xmark"
            let desc = connected ? "MapDrive: connected" : "MapDrive: disconnected"
            let customName = connected ? "connected" : "disconnected"
            if let img = NSImage(named: NSImage.Name(customName)) {
                img.isTemplate = false                     // show the colorful generated icon, not a mono mask
                img.size = NSSize(width: 18, height: 18)   // fit the menu bar
                btn.image = img
            } else if let img = NSImage(systemSymbolName: symbol, accessibilityDescription: desc) {
                img.isTemplate = true   // adapts to light/dark menu bar
                btn.image = img
            } else {
                btn.title = connected ? "MD on" : "MD off"
            }
            btn.toolTip = connected ? "\(mounted.count) share(s) connected" : "No shares connected"
        }
        rebuildMenu(mounted: mounted)
    }

    private func rebuildMenu(mounted: Set<String>? = nil) {
        let mountedSet = mounted ?? mountedShares()
        let menu = NSMenu()

        let header = NSMenuItem(title: "SISP MapDrive", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        let modeItem = NSMenuItem(title: "Mode: \(mode.label)  (\(mode.server))", action: nil, keyEquivalent: "")
        modeItem.isEnabled = false
        menu.addItem(modeItem)
        let userItem = NSMenuItem(title: username.isEmpty ? "Set username..." : "User: \(username)",
                                  action: #selector(setUsername), keyEquivalent: "")
        userItem.target = self
        menu.addItem(userItem)
        menu.addItem(.separator())

        for share in mode.shares {
            let on = mountedSet.contains(share)
            let it = NSMenuItem(title: share, action: #selector(toggleShare(_:)), keyEquivalent: "")
            it.target = self
            it.representedObject = share
            it.state = on ? .on : .off   // checkmark when mounted
            menu.addItem(it)
        }

        menu.addItem(.separator())
        let ca = NSMenuItem(title: "Connect all", action: #selector(connectAll), keyEquivalent: "c")
        ca.target = self; menu.addItem(ca)
        let da = NSMenuItem(title: "Disconnect all", action: #selector(disconnectAll), keyEquivalent: "d")
        da.target = self; menu.addItem(da)
        let open = NSMenuItem(title: "Open in Finder", action: #selector(openVolumes), keyEquivalent: "o")
        open.target = self; menu.addItem(open)

        let modeMenu = NSMenu()
        for m in MODES {
            let mi = NSMenuItem(title: m.label, action: #selector(setMode(_:)), keyEquivalent: "")
            mi.target = self; mi.representedObject = m.id
            mi.state = (m.id == mode.id) ? .on : .off
            modeMenu.addItem(mi)
        }
        let modeParent = NSMenuItem(title: "Connection mode", action: nil, keyEquivalent: "")
        menu.addItem(.separator())
        menu.setSubmenu(modeMenu, for: modeParent)
        menu.addItem(modeParent)

        menu.addItem(.separator())
        let q = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
        q.target = self; menu.addItem(q)

        statusItem.menu = menu
    }

    @discardableResult
    private func runShell(_ launchPath: String, _ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: launchPath)
        p.arguments = args
        do { try p.run(); p.waitUntilExit(); return p.terminationStatus } catch { return -1 }
    }
}

// Single-file entry point (no @main, since this file also has top-level declarations):
// create the app + delegate and run the event loop.
let nsApp = NSApplication.shared
let appDelegate = AppDelegate()
nsApp.delegate = appDelegate
nsApp.run()
