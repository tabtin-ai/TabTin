import AVFoundation
import SwiftUI

struct MobileEnvironmentQRScannerSheet: View {
    let onScan: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                MobileEnvironmentQRScannerView { value in
                    onScan(value)
                    dismiss()
                }
                .ignoresSafeArea()

                RoundedRectangle(cornerRadius: 20)
                    .stroke(.white, lineWidth: 3)
                    .frame(width: 250, height: 250)
                    .shadow(color: .black.opacity(0.3), radius: 8)

                VStack {
                    Spacer()
                    Text(L10n.Debug.scanPrompt)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.white)
                        .padding(.horizontal, TTSpacing.lg)
                        .padding(.vertical, TTSpacing.md)
                        .background(.black.opacity(0.65), in: Capsule())
                        .padding(.bottom, TTSpacing.huge)
                }
            }
            .navigationTitle(L10n.Debug.scanTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.cancel) { dismiss() }
                }
            }
        }
    }
}

private struct MobileEnvironmentQRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> MobileEnvironmentQRScannerViewController {
        MobileEnvironmentQRScannerViewController(onScan: onScan)
    }

    func updateUIViewController(
        _ uiViewController: MobileEnvironmentQRScannerViewController,
        context: Context
    ) {}
}

@MainActor
private final class MobileEnvironmentQRScannerViewController: UIViewController,
    AVCaptureMetadataOutputObjectsDelegate {
    private let captureSession = AVCaptureSession()
    private let onScan: (String) -> Void
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var hasScanned = false

    init(onScan: @escaping (String) -> Void) {
        self.onScan = onScan
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        prepareCamera()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        captureSession.stopRunning()
    }

    private func prepareCamera() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureCaptureSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                guard granted else { return }
                Task { @MainActor [weak self] in
                    self?.configureCaptureSession()
                }
            }
        case .denied, .restricted:
            return
        @unknown default:
            return
        }
    }

    private func configureCaptureSession() {
        guard captureSession.inputs.isEmpty,
              let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              captureSession.canAddInput(input) else {
            return
        }

        captureSession.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard captureSession.canAddOutput(output) else { return }
        captureSession.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let previewLayer = AVCaptureVideoPreviewLayer(session: captureSession)
        previewLayer.videoGravity = .resizeAspectFill
        view.layer.insertSublayer(previewLayer, at: 0)
        self.previewLayer = previewLayer
        captureSession.startRunning()
    }

    nonisolated func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else {
            return
        }
        Task { @MainActor [weak self] in
            guard let self, !hasScanned else { return }
            hasScanned = true
            captureSession.stopRunning()
            onScan(value)
        }
    }
}
