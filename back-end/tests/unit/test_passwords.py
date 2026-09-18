from app.security.passwords import hash_password, verify_password


def test_password_hash_has_unique_salt_and_preserves_unicode():
    password = "Minha frase única 🔐 com acentuação"
    first, second = hash_password(password), hash_password(password)
    assert first != second
    assert verify_password(password, first)
    assert verify_password(password, second)
    assert not verify_password(password + "!", first)


def test_missing_or_corrupted_password_hash_never_authenticates():
    assert not verify_password("Uma senha segura", None)
    assert not verify_password("Uma senha segura", "scrypt$9999999999$8$3$invalid$invalid")
