package com.kruegerco.silentsum.SignUp

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.GridLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.kruegerco.silentsum.DashboardActivity
import com.kruegerco.silentsum.R

class LoginActivity : AppCompatActivity() {

    private lateinit var display: TextView
    private lateinit var pinProgress: TextView
    private var currentInput = ""
    private var operator: String? = null
    private var operand1: Double? = null
    private var currentPinIndex = 0
    private var userPin: String = ""
    private var enteredPin = StringBuilder()

    private lateinit var loginButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)
        display = findViewById(R.id.display)
        pinProgress = findViewById(R.id.pin_progress)
        loginButton = findViewById(R.id.login_button)
        loginButton.visibility = View.GONE

        val prefs = getSharedPreferences("user", Context.MODE_PRIVATE)
        userPin = prefs.getString("pin", "") ?: ""


        updatePinProgress()

        val gridLayout = findViewById<GridLayout>(R.id.gridLayout)
        for (i in 0 until gridLayout.childCount) {
            val button = gridLayout.getChildAt(i) as Button
            val text = button.text.toString()

            button.setOnClickListener { onButtonClick(text) }

            // Long press on "=" to navigate to registration
            if (text == "=") {
                button.setOnLongClickListener {
                    goToRegistration()
                    true
                }
            }
        }

        loginButton.setOnClickListener {
            if (enteredPin.toString() == userPin) {
                startActivity(Intent(this, DashboardActivity::class.java))
                finish()
            } else {
                display.text = "Incorrect PIN. Try again."
                enteredPin.clear()
                currentPinIndex = 0
                updatePinProgress()
                loginButton.visibility = View.GONE
            }
        }
    }

    private fun onButtonClick(text: String) {
        when (text) {
            in "0".."9" -> {
                currentInput += text
                display.text = currentInput
            }
            "+", "-", "*", "/" -> {
                operand1 = currentInput.toDoubleOrNull()
                operator = text
                currentInput = ""
            }
            "=" -> {
                if (currentPinIndex >= userPin.length) {
                    display.text = "PIN complete. Press Login."
                    return
                }

                val operand2 = currentInput.toDoubleOrNull()
                val result = when (operator) {
                    "+" -> operand1?.plus(operand2 ?: 0.0)
                    "-" -> operand1?.minus(operand2 ?: 0.0)
                    "*" -> operand1?.times(operand2 ?: 0.0)
                    "/" -> operand1?.div(operand2 ?: 1.0)
                    else -> null
                }

                val correctDigit = userPin.getOrNull(currentPinIndex)?.toString()
                if (result?.toInt()?.toString() == correctDigit) {
                    enteredPin.append(correctDigit)
                    currentPinIndex++
                    display.text = "Correct ($currentPinIndex/${userPin.length})"
                    updatePinProgress()

                    if (currentPinIndex == userPin.length) {
                        display.text = "PIN complete. Press Login."
                        loginButton.visibility = View.VISIBLE // Show login button
                    }
                } else {
                    display.text = result?.toString() ?: "Error"
                }

                currentInput = ""
                operand1 = null
                operator = null
            }
            "C" -> {
                currentInput = ""
                operand1 = null
                operator = null
                display.text = "0"
            }
        }
    }

    private fun updatePinProgress() {
        val filled = "●".repeat(currentPinIndex)
        val empty = "○".repeat(userPin.length - currentPinIndex)
        pinProgress.text = filled + empty
    }

    private fun goToRegistration() {
        startActivity(Intent(this, RegisterActivity::class.java))
    }
}
