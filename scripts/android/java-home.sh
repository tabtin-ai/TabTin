#!/usr/bin/env bash
# Resolve JAVA_HOME for tabtin-android Gradle builds.
# Sourced by android-build-release-apk.sh and other Android tooling.

android_resolve_java_home() {
    if [[ -n "${JAVA_HOME:-}" && -x "${JAVA_HOME}/bin/java" ]]; then
        return 0
    fi

    if command -v /usr/libexec/java_home >/dev/null 2>&1; then
        local detected
        detected="$(/usr/libexec/java_home 2>/dev/null || true)"
        if [[ -n "${detected}" && -x "${detected}/bin/java" ]]; then
            export JAVA_HOME="${detected}"
            return 0
        fi
    fi

    local candidate
    for candidate in \
        "/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
        "${HOME}/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    do
        if [[ -x "${candidate}/bin/java" ]]; then
            export JAVA_HOME="${candidate}"
            return 0
        fi
    done

    # 带版本的 keg（openjdk@21 等）默认不 link，/usr/libexec/java_home 看不见它们，
    # 所以逐个探；每个 keg 优先取 libexec 下的标准 JDK home，退回 keg 根。
    if command -v brew >/dev/null 2>&1; then
        local formula brew_prefix keg_home
        for formula in openjdk openjdk@21 openjdk@17 openjdk@11; do
            brew_prefix="$(brew --prefix "${formula}" 2>/dev/null || true)"
            [[ -n "${brew_prefix}" ]] || continue
            for keg_home in \
                "${brew_prefix}/libexec/openjdk.jdk/Contents/Home" \
                "${brew_prefix}"
            do
                if [[ -x "${keg_home}/bin/java" ]]; then
                    export JAVA_HOME="${keg_home}"
                    return 0
                fi
            done
        done
    fi

    return 1
}
