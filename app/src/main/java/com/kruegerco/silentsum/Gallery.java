package com.kruegerco.silentsum;

import android.os.Bundle;
import android.os.Environment;
import android.view.View;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

public class Gallery extends Fragment {

    private RecyclerView recyclerView;

    public Gallery() {
        super(R.layout.gallery_three);
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);

        recyclerView = view.findViewById(R.id.imageRecyclerView);
        recyclerView.setLayoutManager(new GridLayoutManager(requireContext(), 3));

        File imageDir = new File(Environment.getExternalStoragePublicDirectory(
                Environment.DIRECTORY_PICTURES), "silentsum");

        if (imageDir.exists() && imageDir.isDirectory()) {
            File[] files = imageDir.listFiles();
            List<String> imagePaths = new ArrayList<>();
            if (files != null) {
                for (File file : files) {
                    if (file.getName().endsWith(".jpg") || file.getName().endsWith(".png")) {
                        imagePaths.add(file.getAbsolutePath());
                    }
                }
                recyclerView.setAdapter(new ImageAdapter(imagePaths));
            } else {
                Toast.makeText(requireContext(), "No images found", Toast.LENGTH_SHORT).show();
            }
        } else {
            Toast.makeText(requireContext(), "Image directory not found", Toast.LENGTH_SHORT).show();
        }
    }
}
