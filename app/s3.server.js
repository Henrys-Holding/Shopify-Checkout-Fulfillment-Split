import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import "dotenv/config"; 

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    endpoint: process.env.AWS_ENDPOINT,
});

export async function getS3ImageSignedURL(key) {
    // Assuming 'key' is the S3 key for the image you're accessing
    const command = new GetObjectCommand({
        Bucket: 'credit-card-verification', // Your bucket name
        Key: key,
    });

    console.log(`Command to get signed URL: ${JSON.stringify(command)}`);

    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 60 * 5 });
    console.log(`Generated signed URL: ${signedUrl}`);
    return signedUrl
}

export async function uploadImageToS3(bucketName, key, imageBuffer) {
    try {
        const uploadParams = {
            Bucket: bucketName,
            Key: key,
            Body: imageBuffer,
            ContentType: 'image/jpeg', // Set the correct content type
        };

        await s3Client.send(new PutObjectCommand(uploadParams));
    } catch (err) {
        console.error('Error uploading image:', err);
        throw err;
    }
}

export default s3Client