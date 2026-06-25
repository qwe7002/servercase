# SSHJ + BouncyCastle rely on reflection for algorithm providers.
-keep class com.hierynomus.** { *; }
-keep class net.schmizz.** { *; }
-keep class org.bouncycastle.** { *; }
-dontwarn org.bouncycastle.**
-dontwarn org.slf4j.**

# kotlinx.serialization generated serializers.
-keepclassmembers class **$$serializer { *; }
-keepclasseswithmembers class * { @kotlinx.serialization.Serializable <fields>; }
