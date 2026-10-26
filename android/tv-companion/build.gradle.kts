import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application") version "8.13.0"
    id("org.jetbrains.kotlin.android") version "2.2.20"
}

android {
    namespace = "com.ps5cafe.tvcompanion"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.ps5cafe.tvcompanion"
        minSdk = 23
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        // assembleDebug is the only build used for the physical test. It is signed with the
        // local Android debug key, so it is installable with `adb install` but is not a
        // production signing identity.
        getByName("debug") {
            isMinifyEnabled = false
        }
        getByName("release") {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        // The lint report is reviewed by hand; see README.md. Errors still fail the build.
        abortOnError = true
        checkReleaseBuilds = false
        // Version-upgrade checks need network lookups and are not correctness findings.
        disable += setOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    // Deliberately no runtime libraries beyond the Kotlin standard library: no AndroidX,
    // no analytics, no crash reporting, no Google Play services.
    testImplementation("junit:junit:4.13.2")
    // Android ships org.json at runtime; JVM unit tests need a real implementation of it.
    testImplementation("org.json:json:20180813")
}
