use std::{collections::HashMap, sync::Arc, time::Duration};

use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde::Deserialize;
use tokio::sync::RwLock;

/// Claims we actually care about from a Cognito *access* token. Access
/// tokens (unlike ID tokens) carry no `aud` claim - Cognito puts the app
/// client id in `client_id` and marks the token's purpose via `token_use`
/// instead. Mirrors `backend/.../CognitoAccessTokenValidator.java` exactly.
#[derive(Debug, Deserialize, Clone)]
pub struct Claims {
    pub sub: String,
    pub token_use: String,
    pub client_id: Option<String>,
    #[allow(dead_code)]
    pub exp: usize,
    /// Cognito User Pool Group names ("admin", "moderator") - see
    /// frontend/amplify/auth/resource.ts. Absent for a plain user.
    #[serde(rename = "cognito:groups", default)]
    pub groups: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(Debug, Deserialize)]
struct Jwk {
    kid: String,
    n: String,
    e: String,
}

/// Verifies Cognito access tokens against the user pool's JWKS. The key set
/// is cached in memory and refreshed on an unknown `kid` (key rotation) or
/// on a periodic background timer, so steady-state verification never pays
/// a network round trip.
pub struct CognitoVerifier {
    issuer: String,
    client_id: String,
    jwks_url: String,
    http: reqwest::Client,
    keys: RwLock<HashMap<String, DecodingKey>>,
}

impl CognitoVerifier {
    pub fn new(issuer: String, client_id: String) -> Self {
        let jwks_url = format!("{}/.well-known/jwks.json", issuer.trim_end_matches('/'));
        Self {
            issuer,
            client_id,
            jwks_url,
            http: reqwest::Client::new(),
            keys: RwLock::new(HashMap::new()),
        }
    }

    /// Fetches and replaces the cached JWKS. Called once at startup (so the
    /// first real request doesn't pay the fetch) and on a background
    /// interval thereafter.
    pub async fn refresh_jwks(&self) -> anyhow::Result<()> {
        let jwks: Jwks = self
            .http
            .get(&self.jwks_url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        let mut keys = self.keys.write().await;
        keys.clear();
        for jwk in jwks.keys {
            let key = DecodingKey::from_rsa_components(&jwk.n, &jwk.e)?;
            keys.insert(jwk.kid, key);
        }
        Ok(())
    }

    pub fn spawn_periodic_refresh(self: &Arc<Self>) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(3600));
            interval.tick().await; // first tick fires immediately; skip it, startup already refreshed
            loop {
                interval.tick().await;
                if let Err(err) = this.refresh_jwks().await {
                    tracing::warn!(error = %err, "periodic JWKS refresh failed, keeping previous key set");
                }
            }
        });
    }

    async fn get_key(&self, kid: &str) -> anyhow::Result<DecodingKey> {
        if let Some(key) = self.keys.read().await.get(kid) {
            return Ok(key.clone());
        }
        // Unknown kid: could be a just-rotated signing key. Refetch once and retry.
        self.refresh_jwks().await?;
        self.keys
            .read()
            .await
            .get(kid)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("unknown signing key"))
    }

    pub async fn verify_access_token(&self, token: &str) -> anyhow::Result<Claims> {
        let header = decode_header(token)?;
        let kid = header
            .kid
            .ok_or_else(|| anyhow::anyhow!("token is missing a key id"))?;
        let key = self.get_key(&kid).await?;

        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[self.issuer.as_str()]);
        validation.validate_aud = false; // Cognito access tokens carry no `aud` claim

        let data = decode::<Claims>(token, &key, &validation)?;
        let claims = data.claims;

        if claims.token_use != "access" {
            anyhow::bail!("expected an access token (token_use=access)");
        }
        if claims.client_id.as_deref() != Some(self.client_id.as_str()) {
            anyhow::bail!("token was not issued to the expected app client");
        }

        Ok(claims)
    }
}

#[cfg(test)]
mod tests {
    use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
    use serde::{Deserialize, Serialize};

    // A throwaway 2048-bit RSA test keypair (not used anywhere real) —
    // generated once for this test, hardcoded rather than generated at test
    // time, since this service has no RSA-keygen dependency of its own and
    // adding one just for a test would be a real, avoidable new dependency.
    const TEST_PRIVATE_KEY_PEM: &str = "-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCRpDWLkACuh+kj
WM6aNe5Hw+MxmEvzGRU5b8VWe9hk49nlOLjgq+qXVuNzyHueJcL2Zx41CXF+9Mlm
c69vCt0jcfA1NRxJ4e75e6qw5CCC6kzFPSWIYAUdp0PS2yzFc6aGaSaQcG3Fobfh
E9Q20a+ahP9vUTU5Q9K5ezqaYtfFeqR+9hlpq25MakrFuGTfSvZdMCMDrFRLOuRN
2OfHFQL8GtJIq1pE1FO3TOJXeS5nZIkgoDUO819Y1MaoNKFliIiXSTwJ0bT8A9v2
62MF9Euc/S2CY3bTrkTbx6j0PczJCsFkWz8UXzWGv4lKOzh/vcJqQJ8RSDhyG/7x
/Yj56oCTAgMBAAECggEACgY6P0MSoPCu3dAg1vbA/K82xd+cfqd/0VES9/Bp77Z1
IB9cLkP2+iKwth6a+kLRcqycpNGOaSAdH/r0x25Wfo2QQdadfgJZ31HL6QVSrYrF
7PTX+VUulPYXJ34OzKpjUFtlcZ9OFu0aHxkCdswjoOg9kqJiyPBqTST2XtD7LAGP
OcarKaGtgcxofhcMWdMFBmh5YrNFxbtFUIa9CS0J+iyJ1rZn24xM4G/fD4mK+Tbz
HA/Kb4VWjdcPKkvA6nRWKmxTsXRRxptyesDqd5I7xc9mLN5vi0SE0hcTVXJRA6nL
PRPn1r9Uy6cba4qekJlO9mlrhIIo0wsQF9oSW/DX/QKBgQDLijF0w4VtiBKiwHye
aJVZaKsMRQLLYjG9AagCmWXmXO5jZfenzIVzq0VOED1Ct5qfo/mgihKduT/5EIH1
3Yms/I6Qll7XJIC/R9YZhegokDJhLpPeKqVB4DtduD4z8wqmcA/9inLjTkYGS2WO
VpaHTK5pTacuK5cJFcKrThV0bQKBgQC3Lc9mtK+jZsDW741D8NQnhRioDI4ibMif
oiYUlLapHmuzpUXNR0/+3nGGv37lrNxiq9iKjQGhbN3fD8MPNtgqNeF9uwM4yDRr
jHhfnYmpsTZwaU3k24qIwqtSoTxmWx+ssSECORHjhEqv2/Bvrx/Ijtr2Ac9eckz5
21ADWDSo/wKBgQCOg/SdDUofp2dlDeI0CIaKU/9wV+HdBqRM8xvwtffjlK5Was89
brcChqnAPx6l2Gkr3mSrRAJE7bEdc7GLtdLwjOZF1wQRID4FsQb4WAp2XIDqCvL+
XF3aAmeO97KWLVcHsu9/V7GZ9vSQ87noMDi2A7sbgIPOkDbw5Yuo5sOfAQKBgGbp
KrMl4eMoMEDQtomr/FTzloWbACNhAFmGzGQVpIVg3NtBh/SrEss6h4dPgGhidDJP
H0m/rGHXetL91PVwN4OHX9a2QToeaCzf7ySwqg2WzOHcl3Fy0eLBk2TJxtgua54m
qUfJbj5nLVqdcvgb5/xSHbvGCo2iI5Lf3pTycitbAoGBAMRms76Qp4O9EDC+m6Yb
Dgtrt4WmJ+XPMxwghiys4X4UM5L9a3rWSmhPN5DdrrSmOt+1bWsxqE+qbATiZA7s
U6tGRIBigNht9NwitOSqcUs5TNix0CJdtT12muibLbgzHFurIx5kldmwLxcOf+aR
6bJpdpiLvdfiEtezcbAJzFbx
-----END PRIVATE KEY-----";
    const TEST_PUBLIC_KEY_PEM: &str = "-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkaQ1i5AArofpI1jOmjXu
R8PjMZhL8xkVOW/FVnvYZOPZ5Ti44Kvql1bjc8h7niXC9mceNQlxfvTJZnOvbwrd
I3HwNTUcSeHu+XuqsOQggupMxT0liGAFHadD0tssxXOmhmkmkHBtxaG34RPUNtGv
moT/b1E1OUPSuXs6mmLXxXqkfvYZaatuTGpKxbhk30r2XTAjA6xUSzrkTdjnxxUC
/BrSSKtaRNRTt0ziV3kuZ2SJIKA1DvNfWNTGqDShZYiIl0k8CdG0/APb9utjBfRL
nP0tgmN2065E28eo9D3MyQrBZFs/FF81hr+JSjs4f73CakCfEUg4chv+8f2I+eqA
kwIDAQAB
-----END PUBLIC KEY-----";

    #[derive(Serialize, Deserialize)]
    struct TestClaims {
        sub: String,
        exp: usize,
    }

    /// Regression test for a real, previously-shipped bug (found via live
    /// end-to-end testing against an actual Cognito-shaped token, not
    /// assumed): jsonwebtoken 11's RS256 crypto backend is selected via its
    /// own Cargo features (`aws_lc_rs`/`rust_crypto`), and its *default*
    /// features enable neither — so with a bare `jsonwebtoken = "11"`
    /// dependency line, every real RS256 verification (this service's only
    /// real use, via `CognitoVerifier::verify_access_token`) panics
    /// unconditionally, regardless of anything else in the dependency
    /// graph. This exercises the exact same `encode`/`decode` RS256 path
    /// `CognitoVerifier` uses — if `Cargo.toml`'s explicit `aws_lc_rs`
    /// feature is ever dropped again, this fails loudly in `cargo test`
    /// instead of only panicking against a real, live JWT in production.
    #[test]
    fn rs256_encode_and_decode_actually_work() {
        let encoding_key =
            EncodingKey::from_rsa_pem(TEST_PRIVATE_KEY_PEM.as_bytes()).expect("test private key should parse");
        let decoding_key =
            DecodingKey::from_rsa_pem(TEST_PUBLIC_KEY_PEM.as_bytes()).expect("test public key should parse");

        let claims = TestClaims { sub: "test-subject".to_string(), exp: 9_999_999_999 };
        let token = encode(&Header::new(Algorithm::RS256), &claims, &encoding_key).expect("RS256 signing should succeed");

        let mut validation = Validation::new(Algorithm::RS256);
        validation.validate_aud = false;
        let decoded = decode::<TestClaims>(&token, &decoding_key, &validation).expect("RS256 verification should succeed, not panic");
        assert_eq!(decoded.claims.sub, "test-subject");
    }
}
