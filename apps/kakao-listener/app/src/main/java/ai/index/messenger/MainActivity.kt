package ai.index.messenger

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

// Settings only: hub address, poll cadence, retry cap, default room.
// No message content is ever shown here — status is metadata only.
class MainActivity : AppCompatActivity() {

    private lateinit var config: BridgeConfig

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        config = BridgeConfig(this)

        val baseUrl = findViewById<EditText>(R.id.baseUrl)
        val authToken = findViewById<EditText>(R.id.authToken)
        val pollSecs = findViewById<EditText>(R.id.pollSecs)
        val maxRetry = findViewById<EditText>(R.id.maxRetry)
        val defaultRoom = findViewById<EditText>(R.id.defaultRoom)
        val status = findViewById<TextView>(R.id.status)
        val sameRoomSecs = findViewById<EditText>(R.id.sameRoomSecs)
        val roomSwitchSecs = findViewById<EditText>(R.id.roomSwitchSecs)
        val quietStart = findViewById<EditText>(R.id.quietStart)
        val quietEnd = findViewById<EditText>(R.id.quietEnd)
        val dailyCap = findViewById<EditText>(R.id.dailyCap)
        val dryRun = findViewById<CheckBox>(R.id.dryRun)
        val allowBackfill = findViewById<CheckBox>(R.id.allowBackfill)

        baseUrl.setText(config.coreBaseUrl)
        authToken.setText(config.coreAuthToken)
        pollSecs.setText(config.pollSecs.toString())
        maxRetry.setText(config.maxRetry.toString())
        defaultRoom.setText(config.defaultRoom)
        sameRoomSecs.setText(config.sameRoomSecs.toString())
        roomSwitchSecs.setText(config.roomSwitchSecs.toString())
        quietStart.setText(config.quietStart.toString())
        quietEnd.setText(config.quietEnd.toString())
        dailyCap.setText(config.dailyCap.toString())
        dryRun.isChecked = config.dryRun
        allowBackfill.isChecked = config.allowBackfill
        status.text = "listener-bound room count: (see system notification)"

        findViewById<Button>(R.id.save).setOnClickListener {
            config.coreBaseUrl = baseUrl.text.toString()
            config.coreAuthToken = authToken.text.toString()
            config.pollSecs = pollSecs.text.toString().toIntOrNull() ?: 3
            config.maxRetry = maxRetry.text.toString().toIntOrNull() ?: 5
            config.defaultRoom = defaultRoom.text.toString()
            config.sameRoomSecs = sameRoomSecs.text.toString().toIntOrNull() ?: 30
            config.roomSwitchSecs = roomSwitchSecs.text.toString().toIntOrNull() ?: 10
            config.quietStart = quietStart.text.toString().toIntOrNull() ?: 1
            config.quietEnd = quietEnd.text.toString().toIntOrNull() ?: 7
            config.dailyCap = dailyCap.text.toString().toIntOrNull() ?: 50
            config.dryRun = dryRun.isChecked
            config.allowBackfill = allowBackfill.isChecked
            ContextCompat.startForegroundService(this, Intent(this, PollService::class.java))
            status.text = "saved — poll loop running"
        }

        findViewById<Button>(R.id.openAccess).setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
    }
}
