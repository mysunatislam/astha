package com.astha.companion;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * AES-256-GCM with a key generated inside Android Keystore. The key material never enters
 * the app's memory and cannot be exported or restored onto another phone. No user
 * authentication is required, because reconnecting a blind user's camera must not ask for a
 * fingerprint each time; the key is still bound to this app and this device.
 */
final class KeystorePairingCrypto implements CameraPairingVault.Crypto {
    private static final String PROVIDER = "AndroidKeyStore";
    private static final String ALIAS = "astha_camera_pairing_v1";
    private static final int IV_BYTES = 12;

    private synchronized SecretKey key() throws GeneralSecurityException {
        try {
            KeyStore store = KeyStore.getInstance(PROVIDER);
            store.load(null);
            KeyStore.Entry entry = store.getEntry(ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        } catch (java.io.IOException unreadable) {
            throw new GeneralSecurityException("keystore_unavailable");
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER);
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    @Override
    public byte[] seal(byte[] plain, byte[] associated) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(associated);
        byte[] body = cipher.doFinal(plain);
        byte[] iv = cipher.getIV();
        if (iv == null || iv.length != IV_BYTES) throw new GeneralSecurityException("unexpected_iv");
        byte[] sealed = Arrays.copyOf(iv, IV_BYTES + body.length);
        System.arraycopy(body, 0, sealed, IV_BYTES, body.length);
        return sealed;
    }

    @Override
    public byte[] open(byte[] sealed, byte[] associated) throws GeneralSecurityException {
        if (sealed == null || sealed.length <= IV_BYTES + 16) throw new GeneralSecurityException("short_record");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, sealed, 0, IV_BYTES));
        cipher.updateAAD(associated);
        return cipher.doFinal(sealed, IV_BYTES, sealed.length - IV_BYTES);
    }
}
