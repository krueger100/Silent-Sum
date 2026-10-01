import ExpoModulesCore
import Photos
import PhotosUI
import UniformTypeIdentifiers

// UNVERIFIED: written on a Windows machine with no macOS, Xcode or simulator available, so this
// file has never been compiled or run. Treat every line as a first draft that needs a build and a
// device pass before it is trusted. The Android half of this module is verified; this is not.
//
// The shape mirrors Android deliberately. There, `ACTION_OPEN_DOCUMENT` yields a document URI that
// identifies the exact item and authorises deleting it. Here the equivalent is `PHPicker`
// configured with a photo library, which returns a `localIdentifier` for each chosen asset --
// again the exact item, not a description of it, so deletion can never land on the wrong photo.
//
// Deleting goes through `PHPhotoLibrary.performChanges`, which raises iOS's own confirmation sheet
// and cannot be suppressed. That is the same bargain as Android's delete dialog: the user is asked
// every time, by the system, and a refusal is an ordinary answer rather than an error.

public final class VaultMediaModule: Module {
  private var pickContinuation: CheckedContinuation<[[String: Any?]], Error>?

  public func definition() -> ModuleDefinition {
    Name("VaultMedia")

    AsyncFunction("pickAsync") { (options: PickOptions, promise: Promise) in
      DispatchQueue.main.async {
        self.presentPicker(options: options, promise: promise)
      }
    }

    AsyncFunction("deleteAsync") { (identifiers: [String], promise: Promise) in
      self.deleteAssets(identifiers: identifiers, promise: promise)
    }

    AsyncFunction("canDeleteAsync") { (identifiers: [String]) -> [Bool] in
      let fetched = PHAsset.fetchAssets(withLocalIdentifiers: identifiers, options: nil)
      var found = Set<String>()
      fetched.enumerateObjects { asset, _, _ in found.insert(asset.localIdentifier) }
      // An asset the library still knows about can be deleted; the user is asked at the point of
      // deletion, so "can" here means "exists and is ours to ask about", nothing stronger.
      return identifiers.map { found.contains($0) }
    }
  }

  // MARK: - Picking

  private func presentPicker(options: PickOptions, promise: Promise) {
    guard let presenter = appContext?.utilities?.currentViewController() else {
      promise.reject(VaultMediaError.noPresenter)
      return
    }

    // Passing the shared library is what makes `assetIdentifier` non-nil. Without it PHPicker
    // hands back anonymous item providers and the original could never be identified again.
    var configuration = PHPickerConfiguration(photoLibrary: .shared())
    configuration.selectionLimit = options.allowsMultipleSelection ? 0 : 1
    configuration.preferredAssetRepresentationMode = .current
    configuration.filter = Self.filter(for: options.mimeTypes)

    let picker = PHPickerViewController(configuration: configuration)
    let delegate = PickerDelegate { [weak self] results in
      guard let self else { return }
      Task { await self.handle(results: results, promise: promise) }
    }
    picker.delegate = delegate
    // The delegate is owned by the controller for the life of the presentation; without this it is
    // deallocated immediately and the callback never fires.
    objc_setAssociatedObject(picker, &PickerDelegate.associationKey, delegate, .OBJC_ASSOCIATION_RETAIN)
    presenter.present(picker, animated: true)
  }

  private static func filter(for mimeTypes: [String]) -> PHPickerFilter? {
    let wantsImages = mimeTypes.contains { $0.hasPrefix("image") }
    let wantsVideos = mimeTypes.contains { $0.hasPrefix("video") }
    switch (wantsImages, wantsVideos) {
    case (true, true): return .any(of: [.images, .videos])
    case (true, false): return .images
    case (false, true): return .videos
    default: return nil
    }
  }

  private func handle(results: [PHPickerResult], promise: Promise) async {
    var picked: [[String: Any?]] = []
    for result in results {
      guard let copied = await Self.copyToCache(result: result) else { continue }
      picked.append(copied)
    }
    promise.resolve(picked)
  }

  /// Copies one chosen item into app-private cache, keeping its asset identifier alongside.
  private static func copyToCache(result: PHPickerResult) async -> [String: Any?]? {
    let provider = result.itemProvider
    guard let typeIdentifier = provider.registeredTypeIdentifiers.first else { return nil }

    return await withCheckedContinuation { continuation in
      provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, _ in
        guard let url else {
          continuation.resume(returning: nil)
          return
        }
        do {
          let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("vault-import", isDirectory: true)
          try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
          // A random name: this file is never shown to anyone, and a cache listing should not say
          // which of the user's photos is being imported.
          let target = directory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension(url.pathExtension)
          try FileManager.default.copyItem(at: url, to: target)

          let size = (try? target.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? -1
          let mimeType = UTType(typeIdentifier)?.preferredMIMEType
          continuation.resume(returning: [
            "uri": target.absoluteString,
            // The asset identifier IS the handle. Empty when the item came from outside the photo
            // library, in which case there is nothing of the user's to delete.
            "documentUri": result.assetIdentifier ?? "",
            "fileName": provider.suggestedName,
            "fileSize": size >= 0 ? Double(size) : nil,
            "mimeType": mimeType,
            "deletable": result.assetIdentifier != nil,
          ])
        } catch {
          continuation.resume(returning: nil)
        }
      }
    }
  }

  // MARK: - Deleting

  private func deleteAssets(identifiers: [String], promise: Promise) {
    let wanted = identifiers.filter { !$0.isEmpty }
    guard !wanted.isEmpty else {
      promise.resolve(0)
      return
    }

    let assets = PHAsset.fetchAssets(withLocalIdentifiers: wanted, options: nil)
    guard assets.count > 0 else {
      promise.resolve(0)
      return
    }

    PHPhotoLibrary.shared().performChanges {
      PHAssetChangeRequest.deleteAssets(assets)
    } completionHandler: { success, _ in
      // A refusal at the system sheet arrives here as `success == false`. The vault copies are
      // already committed, so that is a kept original, not a failed import.
      promise.resolve(success ? assets.count : 0)
    }
  }
}

struct PickOptions: Record {
  @Field var mimeTypes: [String] = ["image/*", "video/*"]
  @Field var allowsMultipleSelection: Bool = true
}

enum VaultMediaError: Error, LocalizedError {
  case noPresenter

  var errorDescription: String? {
    switch self {
    case .noPresenter: return "No view controller available to present the picker from."
    }
  }
}

final class PickerDelegate: NSObject, PHPickerViewControllerDelegate {
  static var associationKey: UInt8 = 0
  private let onFinish: ([PHPickerResult]) -> Void

  init(onFinish: @escaping ([PHPickerResult]) -> Void) {
    self.onFinish = onFinish
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    onFinish(results)
  }
}
