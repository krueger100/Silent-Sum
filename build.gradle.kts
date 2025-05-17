plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
}

buildscript {
    dependencies {
        classpath("com.android.tools.build:gradle:7.1.2")
        classpath("com.google.gms:google-services:4.3.15")
    }
}

allprojects {
    repositories {
    }
}
