package com.astha.companion;

import static org.junit.Assert.*;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import org.junit.Test;

/** The Keystore is replaced by a software AES-GCM key; Android itself is not exercised here. */
public class CameraPairingVaultTest {
    private static final String TOKEN = "kkkkkkkkkkSecret_Pairing-Code" + "zzzzzzzzzzzzzzzzzzzz";
    private static final String HOST = "https://hemovasc-pi.local:8443";

    static final class MemoryStorage implements CameraPairingVault.Storage {
        final Map<String, String> values = new HashMap<>();
        @Override public String get(String key) { return values.get(key); }
        @Override public void put(String key, String value) { values.put(key, value); }
        @Override public void remove(String key) { values.remove(key); }
    }

    static final class SoftwareCrypto implements CameraPairingVault.Crypto {
        SecretKey key;
        SoftwareCrypto() throws GeneralSecurityException { rotate(); }
        void rotate() throws GeneralSecurityException {
            KeyGenerator generator = KeyGenerator.getInstance("AES");
            generator.init(256);
            key = generator.generateKey();
        }
        @Override public byte[] seal(byte[] plain, byte[] associated) throws GeneralSecurityException {
            byte[] iv = new byte[12];
            new SecureRandom().nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
            cipher.updateAAD(associated);
            byte[] body = cipher.doFinal(plain);
            byte[] sealed = Arrays.copyOf(iv, 12 + body.length);
            System.arraycopy(body, 0, sealed, 12, body.length);
            return sealed;
        }
        @Override public byte[] open(byte[] sealed, byte[] associated) throws GeneralSecurityException {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, sealed, 0, 12));
            cipher.updateAAD(associated);
            return cipher.doFinal(sealed, 12, sealed.length - 12);
        }
    }

    private static CameraPairingVault.Record record() {
        CameraPairingVault.Record record = new CameraPairingVault.Record();
        record.origin = HOST;
        record.token = TOKEN;
        record.fallbacks.add("https://172.20.10.11:8443");
        record.deviceId = "Dev1ce_Identity-0123456";
        record.deviceName = "hemovasc-pi";
        record.model = "Raspberry Pi 4\nModel B\u0007";
        record.proof = true;
        return record;
    }

    @Test public void savedRecordIsSealedPerProfileAndReadsBackIntact() throws Exception {
        MemoryStorage storage = new MemoryStorage();
        CameraPairingVault vault = new CameraPairingVault(storage, new SoftwareCrypto());
        vault.save("user-1", record());
        String stored = storage.values.get("kit.user-1");
        assertNotNull(stored);
        assertFalse("the code is never stored as plain text", stored.contains(TOKEN));
        assertFalse(new String(CameraPairingVault.unhex(stored), StandardCharsets.ISO_8859_1).contains(TOKEN));
        CameraPairingVault.Record loaded = vault.load("user-1");
        assertEquals(TOKEN, loaded.token);
        assertEquals(HOST, loaded.origin);
        assertEquals(Arrays.asList("https://172.20.10.11:8443"), loaded.fallbacks);
        assertEquals("Raspberry Pi 4Model B", loaded.model);
        assertTrue(loaded.proof);
        assertNull("another profile sees nothing", vault.load("user-2"));
    }

    @Test public void recordsAreBoundToTheirProfile() throws Exception {
        MemoryStorage storage = new MemoryStorage();
        CameraPairingVault vault = new CameraPairingVault(storage, new SoftwareCrypto());
        vault.save("user-1", record());
        storage.values.put("kit.user-2", storage.values.get("kit.user-1"));
        try { vault.load("user-2"); fail("a copied record must not open for another profile"); }
        catch (CameraPairingVault.Failure expected) { assertEquals("decrypt_failed", expected.code); }
        assertNull("the unreadable copy is removed", storage.values.get("kit.user-2"));
        assertEquals(TOKEN, vault.load("user-1").token);
    }

    @Test public void lostKeyOrTamperingFailsClosedAndForgetsTheRecord() throws Exception {
        MemoryStorage storage = new MemoryStorage();
        SoftwareCrypto crypto = new SoftwareCrypto();
        CameraPairingVault vault = new CameraPairingVault(storage, crypto);
        vault.save("p", record());
        String stored = storage.values.get("kit.p");
        storage.values.put("kit.p", stored.substring(0, stored.length() - 2) + (stored.endsWith("00") ? "11" : "00"));
        try { vault.load("p"); fail(); } catch (CameraPairingVault.Failure expected) { assertEquals("decrypt_failed", expected.code); }
        assertNull(storage.values.get("kit.p"));
        vault.save("p", record());
        crypto.rotate();   // as after a device reset: the Keystore key is gone
        try { vault.load("p"); fail(); } catch (CameraPairingVault.Failure expected) { assertEquals("decrypt_failed", expected.code); }
        assertNull(vault.load("p"));
    }

    @Test public void unsafeValuesAreRefusedBeforeAnythingIsStored() throws Exception {
        MemoryStorage storage = new MemoryStorage();
        CameraPairingVault vault = new CameraPairingVault(storage, new SoftwareCrypto());
        for (String origin : new String[] {"http://pi.local:8443", "https://pi.local:8443/frame", "https://user@pi.local",
                "https://pi.local:99999", "https://PI.local", "https://pi.local?x", null}) {
            CameraPairingVault.Record bad = record();
            bad.origin = origin;
            try { vault.save("p", bad); fail(String.valueOf(origin)); }
            catch (CameraPairingVault.Failure expected) { assertEquals("invalid_pairing", expected.code); }
        }
        CameraPairingVault.Record weak = record();
        weak.token = "short";
        try { vault.save("p", weak); fail(); } catch (CameraPairingVault.Failure expected) { assertEquals("invalid_pairing", expected.code); }
        try { vault.save("../p", record()); fail(); } catch (CameraPairingVault.Failure expected) { assertEquals("invalid_profile", expected.code); }
        assertTrue(storage.values.isEmpty());
    }

    @Test public void fallbacksAreUniqueBoundedAndNeverTheMainAddress() throws Exception {
        CameraPairingVault.Record input = record();
        input.fallbacks.clear();
        for (String origin : new String[] {HOST, "https://a.local", "https://a.local", "https://b.local", "https://c.local", "https://d.local", "https://e.local"})
            input.fallbacks.add(origin);
        input.deviceId = "bad id";
        input.deviceName = "Not A Label";
        CameraPairingVault.Record checked = CameraPairingVault.checked(input);
        assertEquals(Arrays.asList("https://a.local", "https://b.local", "https://c.local", "https://d.local"), checked.fallbacks);
        assertNull(checked.deviceId);
        assertNull(checked.deviceName);
    }

    @Test public void forgetRemovesTheRecord() throws Exception {
        MemoryStorage storage = new MemoryStorage();
        CameraPairingVault vault = new CameraPairingVault(storage, new SoftwareCrypto());
        vault.save("p", record());
        vault.forget("p");
        assertNull(vault.load("p"));
        assertTrue(storage.values.isEmpty());
    }
}
