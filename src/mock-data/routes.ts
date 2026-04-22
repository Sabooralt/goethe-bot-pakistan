
import fs from 'fs/promises';
import path from 'path';

const MOCK_DATA_PATH = path.join(__dirname, '../data/exam-data.json');

// Helper function to read mock data
export async function readMockData(): Promise<any> {
    try {
        const data = await fs.readFile(MOCK_DATA_PATH, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading mock data:', error);
        throw error;
    }
}

// Helper function to write mock data
export async function writeMockData(data: any): Promise<void> {
    try {
        await fs.writeFile(MOCK_DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
        console.log('✅ Mock data updated successfully');
    } catch (error) {
        console.error('Error writing mock data:', error);
        throw error;
    }
}


