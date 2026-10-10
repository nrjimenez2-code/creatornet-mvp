import Capacitor
class CreatorNetViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(CreatorNetSecureStoragePlugin())
        bridge?.registerPluginInstance(CreatorNetSystemBrowserPlugin())
    }
}
