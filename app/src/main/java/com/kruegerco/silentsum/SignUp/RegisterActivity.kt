package com.kruegerco.silentsum.SignUp

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.kruegerco.silentsum.R

class RegisterActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_register)

        val nicknameInput = findViewById<EditText>(R.id.nickname)
        val pinInput = findViewById<EditText>(R.id.pin)
        val confirmPinInput = findViewById<EditText>(R.id.confirm_pin)
        val registerButton = findViewById<Button>(R.id.register_button)

        registerButton.setOnClickListener {
            val nickname = nicknameInput.text.toString().trim()
            val pin = pinInput.text.toString().trim()
            val confirmPin = confirmPinInput.text.toString().trim()

            if (nickname.isEmpty() || pin.isEmpty() || confirmPin.isEmpty()) {
                Toast.makeText(this, "Please fill in all fields", Toast.LENGTH_SHORT).show()
            } else if (pin != confirmPin) {
                Toast.makeText(this, "PINs do not match", Toast.LENGTH_SHORT).show()
            } else if (pin.length < 4) {
                Toast.makeText(this, "PIN must be at least 4 digits", Toast.LENGTH_SHORT).show()
            } else {
                val prefs = getSharedPreferences("user", Context.MODE_PRIVATE)
                prefs.edit().putString("nickname", nickname).putString("pin", pin).apply()
                startActivity(Intent(this, LoginActivity::class.java))
                finish()
            }
        }
    }
}
