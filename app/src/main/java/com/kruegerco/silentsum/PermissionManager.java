package com.kruegerco.silentsum;

import android.content.pm.PackageManager;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.Fragment;
public class PermissionManager {

    public interface PermissionCallback {
        void onPermissionGranted();
        void onPermissionDenied();
    }

    private final Fragment fragment;
    private ActivityResultLauncher<String[]> permissionLauncher;

    public PermissionManager(Fragment fragment) {
        this.fragment = fragment;
        setupPermissionLauncher();
    }

    private void setupPermissionLauncher() {
        permissionLauncher = fragment.registerForActivityResult(
                new ActivityResultContracts.RequestMultiplePermissions(),
                result -> {
                    boolean granted = true;
                    for (Boolean value : result.values()) {
                        if (!Boolean.TRUE.equals(value)) {
                            granted = false;
                            break;
                        }
                    }
                    if (granted) {
                        callback.onPermissionGranted();
                    } else {
                        callback.onPermissionDenied();
                    }
                });
    }

    private PermissionCallback callback;

    public void requestPermissions(String[] permissions, PermissionCallback callback) {
        this.callback = callback;
        permissionLauncher.launch(permissions);
    }
}
