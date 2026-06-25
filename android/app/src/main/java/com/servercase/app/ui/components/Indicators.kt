package com.servercase.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.servercase.app.ui.theme.usageColor

/** Circular percentage gauge. [value] is 0..100 or null for "no data". */
@Composable
fun Gauge(label: String, value: Float?, caption: String? = null, modifier: Modifier = Modifier) {
    val pct = value ?: 0f
    val color = usageColor(pct)
    val track = MaterialTheme.colorScheme.surfaceVariant
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = modifier) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.size(110.dp).padding(6.dp)) {
            Canvas(modifier = Modifier.size(98.dp)) {
                val stroke = Stroke(width = 10.dp.toPx(), cap = StrokeCap.Round)
                val arcSize = Size(size.width - stroke.width, size.height - stroke.width)
                val topLeft = androidx.compose.ui.geometry.Offset(stroke.width / 2, stroke.width / 2)
                drawArc(track, 0f, 360f, false, topLeft = topLeft, size = arcSize, style = stroke)
                drawArc(color, -90f, pct / 100f * 360f, false, topLeft = topLeft, size = arcSize, style = stroke)
            }
            Text(
                if (value == null) "–" else "${pct.toInt()}%",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
        }
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurface)
        if (caption != null) {
            Text(
                caption,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )
        }
    }
}

/** Horizontal usage bar for memory / swap / disks. */
@Composable
fun UsageBar(label: String, detail: String, percent: Float, modifier: Modifier = Modifier) {
    Column(modifier = modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label, style = MaterialTheme.typography.bodyMedium)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
        }
        Box(
            Modifier.fillMaxWidth().height(8.dp)
                .clip(RoundedCornerShape(5.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant)
        ) {
            Box(
                Modifier.fillMaxWidth(percent.coerceIn(0f, 100f) / 100f).height(8.dp)
                    .clip(RoundedCornerShape(5.dp))
                    .background(usageColor(percent))
            )
        }
    }
}
