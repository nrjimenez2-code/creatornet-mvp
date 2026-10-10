import Foundation
import Capacitor
import Security

@objc(CreatorNetSecureStoragePlugin)
public class CreatorNetSecureStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CreatorNetSecureStoragePlugin"
    public let jsName = "CreatorNetSecureStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]
    private let service = "net.creatornet.secure-session"
    private func query(_ call: CAPPluginCall) -> [String: Any]? {
        guard let key = call.getString("key"), key.hasPrefix("creatornet.ios."), key.count <= 200 else {
            call.reject("Invalid secure storage key."); return nil
        }
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service, kSecAttrAccount as String: key,
                kSecAttrSynchronizable as String: false]
    }
    @objc func get(_ call: CAPPluginCall) {
        guard var request = query(call) else { return }
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { call.resolve(["value": NSNull()]); return }
        guard status == errSecSuccess, let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.reject("Secure storage is unavailable."); return
        }
        call.resolve(["value": value])
    }
    @objc func set(_ call: CAPPluginCall) {
        guard var request = query(call), let value = call.getString("value"),
              let data = value.data(using: .utf8), data.count <= 131072 else {
            call.reject("Could not save the session."); return
        }
        let update: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(request as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            request.merge(update) { _, new in new }
            status = SecItemAdd(request as CFDictionary, nil)
        }
        guard status == errSecSuccess else { call.reject("Could not save the session."); return }
        call.resolve()
    }
    @objc func remove(_ call: CAPPluginCall) {
        guard let request = query(call) else { return }
        let status = SecItemDelete(request as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Could not remove the session."); return
        }
        call.resolve()
    }
}
