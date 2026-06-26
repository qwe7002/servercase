package com.servercase.app.data

import kotlinx.serialization.Serializable
import java.util.UUID

enum class AuthType { PASSWORD, KEY }

@Serializable
data class ServerConfig(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val host: String,
    val port: Int = 22,
    val username: String = "root",
    /** Id of the [ServerGroup] this server belongs to, if any. */
    val groupId: String? = null,
    val authType: AuthType = AuthType.PASSWORD,
    val password: String? = null,
    /** PEM private key text when [authType] is [AuthType.KEY]. */
    val privateKey: String? = null,
    val passphrase: String? = null,
)
