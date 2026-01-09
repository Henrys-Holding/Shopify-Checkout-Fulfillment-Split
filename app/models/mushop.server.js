import axios from 'axios';

export async function postAlipayQrCode() {
    return await axios.post('https://mushop.me/TrabajoController/alipay_qr_code');
}