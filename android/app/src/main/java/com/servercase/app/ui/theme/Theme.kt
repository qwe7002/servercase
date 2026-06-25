package com.servercase.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Accent = Color(0xFF4C8DFF)
val Good = Color(0xFF3FB950)
val Warn = Color(0xFFFFB02E)
val Danger = Color(0xFFFF5D5D)

private val DarkColors = darkColorScheme(
    primary = Accent,
    background = Color(0xFF0F1115),
    surface = Color(0xFF161922),
    surfaceVariant = Color(0xFF1D212C),
    onBackground = Color(0xFFD6DBE5),
    onSurface = Color(0xFFD6DBE5),
)

private val LightColors = lightColorScheme(primary = Accent)

/** Returns a usage color: green < 75%, amber < 90%, red otherwise. */
fun usageColor(percent: Float): Color = when {
    percent >= 90f -> Danger
    percent >= 75f -> Warn
    else -> Good
}

@Composable
fun ServerCaseTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = Typography(),
        content = content,
    )
}
