import ExpoModulesCore
import Foundation

public class ICloudKVStoreModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ICloudKVStore")

    Function("setString") { (key: String, value: String) in
      NSUbiquitousKeyValueStore.default.set(value, forKey: key)
    }

    Function("getString") { (key: String) -> String? in
      return NSUbiquitousKeyValueStore.default.string(forKey: key)
    }

    Function("removeItem") { (key: String) in
      NSUbiquitousKeyValueStore.default.removeObject(forKey: key)
    }

    Function("synchronize") { () -> Bool in
      return NSUbiquitousKeyValueStore.default.synchronize()
    }
  }
}
