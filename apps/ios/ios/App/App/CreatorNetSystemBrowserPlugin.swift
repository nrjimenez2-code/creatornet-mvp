import Foundation
import Capacitor
import UIKit

@objc(CreatorNetSystemBrowserPlugin)
public class CreatorNetSystemBrowserPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CreatorNetSystemBrowserPlugin"
    public let jsName = "CreatorNetSystemBrowser"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)]
    @objc func open(_ call: CAPPluginCall) {
        guard let value = call.getString("url"), let parts = URLComponents(string: value),
              parts.scheme == "https", parts.host != nil, parts.user == nil, parts.password == nil,
              !(parts.queryItems ?? []).contains(where: { ["access_token", "refresh_token"].contains($0.name.lowercased()) }),
              !(parts.fragment ?? "").contains("access_token"), !(parts.fragment ?? "").contains("refresh_token"),
              let url = parts.url else { call.reject("Invalid browser destination."); return }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() } else { call.reject("Could not open your browser.") }
            }
        }
    }
}
