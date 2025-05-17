package com.kruegerco.silentsum;

import android.Manifest;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.Toast;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.Fragment;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.File;
import java.util.concurrent.ExecutionException;

public class Camera extends Fragment {

    private PreviewView previewView;
    private ImageCapture imageCapture;
    private Button captureButton;
    private PermissionManager permissionManager;

    public Camera() {
        super(R.layout.camera_two);
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);

        previewView = view.findViewById(R.id.previewView);
        captureButton = view.findViewById(R.id.button_capture);
        permissionManager = new PermissionManager(this);

        captureButton.setOnClickListener(v -> takePhoto());

        permissionManager.requestPermissions(
                new String[]{Manifest.permission.CAMERA},
                new PermissionManager.PermissionCallback() {
                    @Override
                    public void onPermissionGranted() {
                        startCamera();
                    }

                    @Override
                    public void onPermissionDenied() {
                        Toast.makeText(requireContext(), "Camera permission denied", Toast.LENGTH_SHORT).show();
                    }
                }
        );
    }

    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> cameraProviderFuture =
                ProcessCameraProvider.getInstance(requireContext());

        cameraProviderFuture.addListener(() -> {
            try {
                ProcessCameraProvider cameraProvider = cameraProviderFuture.get();

                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());

                imageCapture = new ImageCapture.Builder().build();

                CameraSelector cameraSelector = new CameraSelector.Builder()
                        .requireLensFacing(CameraSelector.LENS_FACING_BACK)
                        .build();

                cameraProvider.unbindAll();
                cameraProvider.bindToLifecycle(this, cameraSelector, preview, imageCapture);

            } catch (ExecutionException | InterruptedException e) {
                e.printStackTrace();
            }
        }, ContextCompat.getMainExecutor(requireContext()));
    }

    private void takePhoto() {
        if (imageCapture == null) return;

        File outputDirectory = new File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES),
                "silentsum"
        );
        if (!outputDirectory.exists()) {
            outputDirectory.mkdirs();
        }

        String imageFileName = "IMG_" + System.currentTimeMillis() + ".jpg";
        File photoFile = new File(outputDirectory, imageFileName);

        ImageCapture.OutputFileOptions outputOptions =
                new ImageCapture.OutputFileOptions.Builder(photoFile).build();

        imageCapture.takePicture(outputOptions, ContextCompat.getMainExecutor(requireContext()),
                new ImageCapture.OnImageSavedCallback() {
                    @Override
                    public void onImageSaved(@NonNull ImageCapture.OutputFileResults outputFileResults) {
                        String savedPath = photoFile.getAbsolutePath();
                        Toast.makeText(requireContext(), "Saved: " + savedPath, Toast.LENGTH_SHORT).show();
                        Log.d("CameraFragment", "Image saved at path: " + savedPath);
                    }

                    @Override
                    public void onError(@NonNull ImageCaptureException exception) {
                        Toast.makeText(requireContext(), "Capture failed: " + exception.getMessage(), Toast.LENGTH_SHORT).show();
                        Log.e("CameraFragment", "Capture error: ", exception);
                    }
                });
    }
}
