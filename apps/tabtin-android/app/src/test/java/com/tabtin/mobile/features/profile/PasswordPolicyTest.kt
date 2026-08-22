package com.tabtin.mobile.features.profile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

public class PasswordPolicyTest {
    @Test
    public fun sanitizeStripsWhitespaceAndReportsIt() {
        val result = PasswordPolicy.sanitize("Abc 1234!")

        assertEquals("Abc1234!", result.value)
        assertTrue(result.hadWhitespace)
        assertTrue(!result.hadCjk)
    }

    @Test
    public fun sanitizeClearsCjkInput() {
        val result = PasswordPolicy.sanitize("Abc中文123!")

        assertEquals("", result.value)
        assertTrue(result.hadCjk)
    }

    @Test
    public fun validateAcceptsThreeCharacterClasses() {
        assertNull(PasswordPolicy.validate("Abc12345", "Abc12345"))
        assertNull(PasswordPolicy.validate("Abc12345!", "Abc12345!"))
    }

    @Test
    public fun validateRejectsWeakAndMismatchedPasswords() {
        assertEquals(
            PasswordPolicy.ValidationError.TOO_SHORT,
            PasswordPolicy.validate("Ab1!", "Ab1!"),
        )
        assertEquals(
            PasswordPolicy.ValidationError.NOT_COMPLEX,
            PasswordPolicy.validate("abcdefgh", "abcdefgh"),
        )
        assertEquals(
            PasswordPolicy.ValidationError.MISMATCH,
            PasswordPolicy.validate("Abc12345", "Abc12346"),
        )
    }
}
